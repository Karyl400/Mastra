import { describe, it, expect, vi } from 'vitest';

import {
  buildSlackRequestContext,
  readSlackContext,
  canPerformSideEffects,
  canReadPersonRecord,
  SLACK_ACCESS_LEVEL_KEY,
} from '../../../src/shared/slack-request-context';
import { makeSendNotification } from '../../../src/features/notification/application/tools/send-notification';
import { InMemoryNotificationRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-notification.repository';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';
import { createEmployee } from '../../../src/features/employee/domain/entities/employee';
import type {
  EmailProvider,
  ChatProvider,
} from '../../../src/features/notification/domain/ports/providers';
import type { SlackWorkspaceProvider } from '../../../src/features/notification/domain/ports/slack-workspace.port';

/**
 * Le niveau d'accès descend jusqu'aux tools par le `requestContext` de Mastra — et par lui
 * SEUL. Le mettre dans le prompt reviendrait à demander au modèle de s'auto-limiter sur une
 * entrée qu'un attaquant contrôle : `PLAN-ARCHITECTURE.md` §3.1 rappelle qu'un garde-fou LLM
 * échoue « ouvert ET bruyant », le texte passant *et devenant attesté conforme*.
 *
 * Ces tests verrouillent les deux propriétés qui font que brancher l'autorisation ne casse
 * rien : l'absence de niveau n'est PAS un refus, et une valeur inconnue n'est PAS interprétée.
 */

const EMPLOYEE_ID = '123e4567-e89b-12d3-a456-426614174000';

describe('Contexte de requête — transport du niveau d’accès', () => {
  it('transporte le niveau jusqu’au tool', () => {
    const ctx = buildSlackRequestContext({
      channel: 'D0MOCKDM01',
      slackUserId: 'U000GUEST',
      accessLevel: 'readonly',
    });

    expect(readSlackContext(ctx)?.accessLevel).toBe('readonly');
  });

  it('ne pose AUCUNE clé quand le niveau n’a pas été évalué', () => {
    const ctx = buildSlackRequestContext({ channel: 'D0MOCKDM01' });

    // Une clé présente à `undefined` obligerait chaque consommateur à refaire la distinction
    // entre « non évalué » et « évalué à rien ».
    expect(ctx.get(SLACK_ACCESS_LEVEL_KEY)).toBeUndefined();
    expect(readSlackContext(ctx)?.accessLevel).toBeUndefined();
  });

  it('IGNORE une valeur inconnue au lieu de l’interpréter', () => {
    // Une faute de frappe côté producteur ne doit se traduire ni par un refus silencieux, ni
    // par une autorisation silencieuse : elle ramène au cas « non évalué ».
    const ctx = { get: (key: string) => (key === 'slackChannel' ? 'D0MOCKDM01' : 'FULL') };

    expect(readSlackContext(ctx)?.accessLevel).toBeUndefined();
    expect(canPerformSideEffects(ctx)).toBe(true);
  });
});

describe('canPerformSideEffects — l’absence de contexte n’est pas un refus', () => {
  it('autorise hors Slack (workflow, playground, test, route /api)', () => {
    // Sans cela, brancher l'autorisation couperait d'un coup le parcours d'onboarding, qui
    // envoie l'email de bienvenue depuis un workflow, sans aucun demandeur Slack.
    expect(canPerformSideEffects(undefined)).toBe(true);
    expect(canPerformSideEffects(null)).toBe(true);
    expect(canPerformSideEffects({})).toBe(true);
  });

  it('autorise `full`, refuse `readonly` et `denied` sur le dossier d’AUTRUI', () => {
    const at = (accessLevel: 'full' | 'readonly' | 'denied') =>
      canPerformSideEffects(
        buildSlackRequestContext({
          channel: 'D0MOCKDM01',
          accessLevel,
          employeeId: 'emp-moi',
        }),
        'emp-quelqu-un-d-autre',
      );

    expect(at('full')).toBe(true);
    expect(at('readonly')).toBe(false);
    expect(at('denied')).toBe(false);
  });
});

describe('canPerformSideEffects — agir sur SOI-MÊME survit à la rétrogradation', () => {
  const self = (accessLevel: 'full' | 'readonly' | 'denied') =>
    buildSlackRequestContext({ channel: 'D0MOCKDM01', accessLevel, employeeId: 'emp-moi' });

  it('autorise un `readonly` à agir sur son propre dossier', () => {
    // La moitié ÉCRITURE de « chacun ses propres données ». Depuis que `full` vaut
    // « manager », `readonly` est le cas nominal de tout le monde : sans cette comparaison,
    // plus personne ne pourrait se programmer un rappel ni faire avancer son parcours.
    expect(canPerformSideEffects(self('readonly'), 'emp-moi')).toBe(true);
  });

  it('vaut aussi pour `denied` — mais ce niveau n’atteint jamais un tool', () => {
    // `denied` est tranché par le handler, bien avant qu'un outil ne s'exécute. On vérifie la
    // cohérence de la fonction, pas un chemin réel.
    expect(canPerformSideEffects(self('denied'), 'emp-moi')).toBe(true);
  });

  it('n’autorise RIEN quand la cible est absente — pas de « soi » sans comparaison', () => {
    // Un appel sans cible ne peut pas prétendre viser son propre dossier. Sans cette garde,
    // omettre le paramètre rendrait la rétrogradation inopérante partout où on l'oublierait.
    expect(canPerformSideEffects(self('readonly'))).toBe(false);
    expect(canPerformSideEffects(self('readonly'), null)).toBe(false);
    expect(canPerformSideEffects(self('readonly'), '   ')).toBe(false);
  });

  it('n’autorise RIEN quand le demandeur n’a pas de dossier connu', () => {
    // Sans `employeeId` côté demandeur, « son propre dossier » n'a pas de référent : la
    // comparaison ne peut pas être vraie par défaut, sans quoi une identité non résolue
    // vaudrait une autorisation.
    const anonymous = buildSlackRequestContext({
      channel: 'D0MOCKDM01',
      accessLevel: 'readonly',
    });

    expect(canPerformSideEffects(anonymous, 'emp-moi')).toBe(false);
  });

  it('applique la MÊME règle que `canReadPersonRecord` — lire et agir ne divergent pas', () => {
    // Les deux moitiés d'un même droit ne doivent pas répondre selon deux règles différentes :
    // c'est la divergence que ce dépôt corrige partout ailleurs.
    const ctx = self('readonly');

    expect(canPerformSideEffects(ctx, 'emp-moi')).toBe(canReadPersonRecord(ctx, 'emp-moi'));
    expect(canPerformSideEffects(ctx, 'emp-autre')).toBe(canReadPersonRecord(ctx, 'emp-autre'));
  });
});

// ---------------------------------------------------------------------------
// Application réelle sur le tool le plus dangereux du dépôt
// ---------------------------------------------------------------------------

function makeTool() {
  const notificationRepo = new InMemoryNotificationRepository();
  const employeeRepo = new InMemoryEmployeeRepository();
  const sendEmail = vi.fn().mockResolvedValue(undefined);
  const sendMessage = vi.fn().mockResolvedValue(undefined);

  const emailProvider = { sendEmail } as unknown as EmailProvider;
  const chatProvider = { sendMessage } as unknown as ChatProvider;
  const workspace = {
    findUserByEmail: vi.fn().mockResolvedValue(null),
  } as unknown as SlackWorkspaceProvider;

  const tool = makeSendNotification(
    notificationRepo,
    employeeRepo,
    emailProvider,
    chatProvider,
    workspace,
  );

  return { tool, employeeRepo, notificationRepo, sendEmail, sendMessage };
}

const INPUT = {
  recipientId: EMPLOYEE_ID,
  subject: 'Bienvenue',
  body: 'Ton parcours démarre lundi.',
};

describe('sendNotification — la frontière d’autorisation', () => {
  it('REFUSE un demandeur en lecture seule, sans aucune E/S ni aucune écriture', async () => {
    const { tool, employeeRepo, notificationRepo, sendEmail } = makeTool();
    await employeeRepo.save(
      createEmployee({
        id: EMPLOYEE_ID,
        firstName: 'Awa',
        lastName: 'Diop',
        email: 'awa.diop@kisso.com',
        department: 'RH',
        position: 'Chargée de mission',
        startDate: '2026-09-01',
        managerId: null,
      }),
    );

    const result = (await tool.execute!(
      INPUT as never,
      {
        requestContext: buildSlackRequestContext({
          channel: 'D0GUESTDM',
          slackUserId: 'U000GUEST',
          accessLevel: 'readonly',
        }),
      } as never,
    )) as { sent: boolean; reason?: string };

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('not_authorized');

    // Le refus arrive AVANT la résolution du destinataire et avant tout transport : un invité
    // externe ne doit pas pouvoir faire partir un email depuis le Gmail de l'entreprise.
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await notificationRepo.findByRecipient(EMPLOYEE_ID)).toHaveLength(0);
  });

  it('n’expose PAS la règle qui a porté', async () => {
    const { tool } = makeTool();

    const result = (await tool.execute!(
      INPUT as never,
      {
        requestContext: buildSlackRequestContext({
          channel: 'D0GUESTDM',
          accessLevel: 'denied',
        }),
      } as never,
    )) as { hint?: string };

    // Nommer le motif renseignerait un attaquant sur la sonde qui a fonctionné — défaut déjà
    // corrigé sur `[SECURITY_BLOCK]`.
    expect(result.hint).not.toMatch(/invit|restricted|guest|domain|annuaire/i);
  });

  it('laisse passer un membre de l’organisation', async () => {
    const { tool, employeeRepo, sendEmail } = makeTool();
    await employeeRepo.save(
      createEmployee({
        id: EMPLOYEE_ID,
        firstName: 'Awa',
        lastName: 'Diop',
        email: 'awa.diop@kisso.com',
        department: 'RH',
        position: 'Chargée de mission',
        startDate: '2026-09-01',
        managerId: null,
      }),
    );

    await tool.execute!(
      INPUT as never,
      {
        requestContext: buildSlackRequestContext({
          channel: 'D0HUMANDM',
          slackUserId: 'U000HUMAN',
          accessLevel: 'full',
        }),
      } as never,
    );

    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
