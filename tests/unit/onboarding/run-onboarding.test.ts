import { describe, it, expect, vi } from 'vitest';

import { runOnboarding } from '../../../src/features/onboarding/application/services/run-onboarding';
import {
  BestEffortStep,
  OnboardingOutcome,
} from '../../../src/features/onboarding/domain/value-objects/onboarding-outcome';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * UN ÉCHEC DE CRÉATION NE DOIT JAMAIS ÊTRE MUET
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `onboarding-outcome.ts` distingue `completed` / `degraded` / `failed` précisément pour que
 * « réussi » cesse de couvrir « rien n'est parti ». Mais le verdict ne vaut que s'il ATTEINT
 * quelqu'un : sur `failed` comme sur `degraded`, l'appelant se contentait longtemps d'une
 * ligne `logger.error`, et la personne qui venait de remplir son dossier ne recevait RIEN.
 *
 * ⚠️ Ces cas étaient couverts par les tests de la route d'interactivité, sur le chemin de la
 * MODALE. Les modales ont été supprimées du dépôt le 2026-08-19 — elles ne s'ouvraient pas —
 * et `runOnboarding` n'a plus qu'un seul appelant : l'échange écrit. Les tests DÉMÉNAGENT avec
 * la responsabilité plutôt que de disparaître avec le chemin mort : la propriété protégée
 * n'était pas « la modale prévient », c'était « personne ne reste sans nouvelle ».
 */

const PROFILE = {
  firstName: 'Alice',
  lastName: 'Martin',
  email: 'alice@kisso.com',
  position: 'Software Engineer',
};

const START = '2026-09-01T00:00:00.000Z';

function workflowReturning(result: unknown) {
  return {
    createRun: async () => ({ start: async () => result }),
  };
}

function deps(workflow: unknown) {
  const notify = vi.fn(async (_text: string) => undefined);
  const onRecordReady = vi.fn(async (_employeeId: string | undefined) => undefined);
  return { getWorkflow: () => workflow, notify, onRecordReady };
}

describe('le workflow est introuvable', () => {
  it('PRÉVIENT au lieu de lever dans une tâche de fond invisible', async () => {
    // ⚠️ `getWorkflow()` prend la CLÉ DU REGISTRE, pas l'`id` interne. Une clé erronée rend
    // `undefined` et lèverait un `TypeError` DANS LA TÂCHE DE FOND — après un 200 déjà rendu,
    // donc sans aucune trace côté utilisateur.
    const d = deps(undefined);

    await runOnboarding(d, PROFILE, START);

    expect(d.notify).toHaveBeenCalledOnce();
    expect(String(d.notify.mock.calls[0]![0])).toContain('pas réussi à enregistrer ton dossier');
    // Aucun dossier : on n'enchaîne sur rien.
    expect(d.onRecordReady).not.toHaveBeenCalled();
  });
});

describe('le run échoue', () => {
  it('demande de recommencer — c’est le SEUL cas où c’est la bonne conduite', async () => {
    const d = deps(workflowReturning({ status: 'failed', error: new Error('turso down') }));

    await runOnboarding(d, PROFILE, START);

    expect(String(d.notify.mock.calls[0]![0])).toContain('pas réussi à enregistrer ton dossier');
    expect(d.onRecordReady).not.toHaveBeenCalled();
  });
});

describe('le run est DÉGRADÉ — le dossier existe', () => {
  it('NOMME ce qui manque, et ne demande PAS de recommencer', async () => {
    const d = deps(
      workflowReturning({
        status: 'success',
        result: {
          employeeId: 'emp-1',
          outcome: OnboardingOutcome.Degraded,
          emailSent: false,
          // ⚠️ La VALEUR de l'enum, telle que le workflow la pousse réellement — jamais un
          // littéral. C'est précisément l'écart entre les deux qui a rendu `describeMissingSteps`
          // muette sur toute dégradation réelle (voir `onboarding-replies.ts`).
          degradedSteps: [{ step: BestEffortStep.WelcomeEmail, reason: 'SMTP timeout' }],
        },
      }),
    );

    await runOnboarding(d, PROFILE, START);

    const dit = String(d.notify.mock.calls[0]?.[0] ?? '');
    expect(dit).not.toContain('pas réussi à enregistrer ton dossier');
    // ⚠️ LE CŒUR DU CORRECTIF DU 2026-08-19. `STEP_LABELS` était indexée sur les NOMS des
    // membres de `BestEffortStep` et non sur leurs VALEURS : `describeMissingSteps` rendait
    // `[]` sur toute dégradation réelle, `runOnboarding` n'envoie rien sur une liste vide, et
    // personne n'était jamais prévenu qu'un email de bienvenue n'était pas parti.
    expect(dit).toContain("l'email de bienvenue ne t'a pas été envoyé");
    // ⚠️ Le dossier EXISTE : la suite du parcours doit s'enchaîner. `degraded` est un
    // ABOUTISSEMENT — le workflow existe pour ne pas perdre la création sur une
    // indisponibilité SMTP de trente secondes.
    expect(d.onRecordReady).toHaveBeenCalledWith('emp-1');
  });

  it('n’envoie RIEN quand la dégradation n’a rien à annoncer', async () => {
    // Une liste vide ne doit pas produire un message creux — « quelque chose a échoué, je ne
    // sais pas quoi » est pire que le silence, et le dossier est bel et bien créé.
    const d = deps(
      workflowReturning({
        status: 'success',
        result: { employeeId: 'emp-1', outcome: OnboardingOutcome.Degraded, degradedSteps: [] },
      }),
    );

    await runOnboarding(d, PROFILE, START);

    expect(d.notify).not.toHaveBeenCalled();
    expect(d.onRecordReady).toHaveBeenCalledWith('emp-1');
  });
});

describe('le run réussit', () => {
  it('ne dit rien de plus et enchaîne sur la suite du parcours', async () => {
    const d = deps(
      workflowReturning({
        status: 'success',
        result: { employeeId: 'emp-1', outcome: OnboardingOutcome.Completed, emailSent: true },
      }),
    );

    await runOnboarding(d, PROFILE, START);

    expect(d.notify).not.toHaveBeenCalled();
    expect(d.onRecordReady).toHaveBeenCalledWith('emp-1');
  });
});

describe('idempotence', () => {
  it('deux soumissions du même profil produisent le MÊME run', async () => {
    // Sans cela, une personne qui redit « j'ai fini » créerait un second dossier.
    const runIds: (string | undefined)[] = [];
    const workflow = {
      createRun: async (options?: { runId?: string }) => {
        runIds.push(options?.runId);
        return { start: async () => ({ status: 'success', result: {} }) };
      },
    };

    await runOnboarding(deps(workflow), PROFILE, START);
    await runOnboarding(deps(workflow), PROFILE, START);

    expect(runIds[0]).toBeTruthy();
    expect(runIds[0]).toBe(runIds[1]);
  });
});
