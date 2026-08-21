import { describe, expect, it, vi } from 'vitest';

import { SlackEventsHandler } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE DOSSIER SE RETROUVE PAR SON LIEN, PAS SEULEMENT PAR UNE ADRESSE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **DÉFAUT REPRODUIT EN PRODUCTION LE 2026-08-21** par le rejeu d'arrivée. La personne a
 * répondu aux quatre questions, le dossier a été CRÉÉ, `submitProfile` a bien relié
 * `slack_directory.employee_id` — et « j'ai fini » a répondu :
 *
 *     « Je ne trouve pas encore de dossier à ton nom — on va arranger ça ensemble, ici même. »
 *
 * Les deux lecteurs du dossier ne passaient QUE par `slack_directory.email`. Cette colonne
 * vient du profil Slack et peut être vide : un invité, un compte dont l'adresse n'est pas
 * exposée, quelqu'un qui ne l'a pas renseignée. L'identifiant du dossier était pourtant dans la
 * ligne qu'on venait de lire.
 *
 * Même famille que la cause racine du 2026-08-19, retournée : là, `employee_id` n'était écrite
 * par AUCUN chemin de production ; ici elle l'est, et n'était lue par aucun.
 *
 * ⚠️ Sans adresse d'annuaire, la conséquence n'est pas seulement un message faux : le parcours
 * repart de zéro, repose les quatre questions, puis échoue sur l'unicité de l'email. C'est la
 * boucle sans sortie, atteinte par un autre chemin.
 */

const RECORD = {
  firstName: 'Amina',
  lastName: 'SONDE-TEST',
  email: 'amina@kissohq.com',
  position: 'Data Analyst',
};

function makeHandler(member: Record<string, unknown>, profileRepo: Record<string, unknown>) {
  const slack = {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1.0' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }) },
  };

  // ⚠️ Les doublures ci-dessous ne sont pas du confort : chaque `undefined` fabrique un dépôt
  // Drizzle ou envoie un `users.info` RÉEL vers slack.com avec le jeton de test. `CLAUDE.md`
  // en recense HUIT, et leur oubli ne produit pas un échec d'assertion mais un `Timeout 5000ms`
  // qui ne désigne jamais sa cause.
  const handler = new SlackEventsHandler(
    'xoxb-test-token',
    { getAgent: () => ({ generate: vi.fn() }) } as never,
    {
      slackClient: slack as never,
      conversationRepository: null,
      pinnedFactRepository: null,
      dedupRepository: { claim: async () => true, prune: async () => 0 } as never,
      rateLimiter: null,
      pruneProbability: 0,
      directoryRepository: { findBySlackUserId: async () => member } as never,
      accessGuard: { evaluate: async () => ({ effective: 'full' }) } as never,
      auditSink: async () => undefined,
      workspaceProvider: { getUserById: async () => null } as never,
      profileRepository: profileRepo as never,
      interviewRepository: null,
    } as never,
  );

  return { handler, slack };
}

function dmEvent(text: string) {
  return {
    type: 'event_callback' as const,
    team_id: 'TMLKC4EPP',
    event_id: `Ev${Math.random().toString(36).slice(2)}`,
    event: {
      type: 'message',
      channel: 'D1',
      channel_type: 'im',
      user: 'U1',
      text,
      ts: String(Date.now() / 1000),
    },
  };
}

const lastText = (slack: { chat: { postMessage: { mock: { calls: unknown[][] } } } }) =>
  (slack.chat.postMessage.mock.calls.at(-1)?.[0] as { text: string })?.text ?? '';

describe('« j’ai fini » retrouve le dossier RELIÉ, même sans adresse dans l’annuaire', () => {
  it('le retrouve par employee_id quand l’annuaire n’a PAS d’email', async () => {
    const findById = vi.fn().mockResolvedValue(RECORD);
    const findByEmail = vi.fn().mockResolvedValue(null);
    const { handler, slack } = makeHandler(
      { slackUserId: 'U1', employeeId: 'emp-1', email: null, realName: 'Amina' },
      { findById, findByEmail },
    );

    await handler.handleEvent(dmEvent("j'ai fini") as never);

    expect(findById).toHaveBeenCalledWith('emp-1');
    expect(lastText(slack)).not.toContain('Je ne trouve pas encore de dossier');
    expect(lastText(slack)).toContain('complet');
  });

  it('retombe sur l’adresse quand aucun lien n’existe encore', async () => {
    // Le cas d'une personne présente dans l'annuaire mais jamais reliée : c'est exactement le
    // retard de rattrapage recensé (2 dossiers pour 6 personnes vivantes).
    const findByEmail = vi.fn().mockResolvedValue(RECORD);
    const { handler, slack } = makeHandler(
      { slackUserId: 'U1', employeeId: null, email: 'amina@kissohq.com' },
      { findById: vi.fn().mockResolvedValue(null), findByEmail },
    );

    await handler.handleEvent(dmEvent("j'ai fini") as never);

    expect(findByEmail).toHaveBeenCalledWith('amina@kissohq.com');
    expect(lastText(slack)).toContain('complet');
  });

  it('dit honnêtement qu’il ne trouve rien quand il n’y a NI lien NI adresse', async () => {
    const { handler, slack } = makeHandler(
      { slackUserId: 'U1', employeeId: null, email: null },
      { findById: vi.fn().mockResolvedValue(null), findByEmail: vi.fn().mockResolvedValue(null) },
    );

    await handler.handleEvent(dmEvent("j'ai fini") as never);

    expect(lastText(slack)).toContain('Je ne trouve pas encore de dossier');
  });

  it('le lien PRIME sur l’adresse — deux sources, une seule autorité', async () => {
    // Si les deux répondent, c'est le lien qui décide : il a été écrit par `submitProfile`,
    // l'adresse d'annuaire est éditée par son porteur.
    const findById = vi.fn().mockResolvedValue(RECORD);
    const findByEmail = vi.fn().mockResolvedValue({ ...RECORD, position: null });
    const { handler, slack } = makeHandler(
      { slackUserId: 'U1', employeeId: 'emp-1', email: 'autre@kissohq.com' },
      { findById, findByEmail },
    );

    await handler.handleEvent(dmEvent("j'ai fini") as never);

    expect(findByEmail).not.toHaveBeenCalled();
    expect(lastText(slack)).toContain('complet');
  });
});
