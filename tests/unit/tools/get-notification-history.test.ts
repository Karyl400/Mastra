/**
 * `getNotificationHistory` — projection, bornage et ordre déterministe.
 *
 * Contexte (campagne du 2026-08-11) : le tool renvoyait les lignes du repository
 * TELLES QUELLES — 18 colonnes, `body` non borné, `limit` par défaut à 50. Mesuré
 * ~10 223 tokens pour 50 lignes, contre un plafond Groq de 100 000 tokens/JOUR :
 * un seul appel brûlait 10 % de la journée, et le résultat restait ensuite dans
 * l'historique de tous les tours suivants.
 *
 * C'est exactement le défaut corrigé pour `getEmployeeProfile` (2 506 → 329) et
 * jamais appliqué ici. Les propriétés verrouillées sont les mêmes que dans
 * `tool-result-budget.test.ts` :
 *   1. BORNE — au plus `MAX_NOTIFICATIONS_IN_RESULT` entrées ;
 *   2. PROJECTION — `body` ne sort pas (c'est le champ le plus lourd, et c'est le
 *      modèle lui-même qui l'a écrit : le lui renvoyer est un coût pur) ;
 *   3. SIGNALISATION — `total` / `shown` disent que la liste est tronquée ;
 *   4. ORDRE — déterministe, du plus récent au plus ancien. Il n'y en avait aucun.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  makeGetNotificationHistory,
  MAX_NOTIFICATIONS_IN_RESULT,
} from '../../../src/features/notification/application/tools/get-notification-history';
import { InMemoryNotificationRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-notification.repository';
import type { Notification } from '../../../src/features/notification/domain/entities/notification';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../src/shared/types';

const RECIPIENT_ID = '11111111-1111-4111-8111-111111111111';

/** Corps volumineux : c'est lui qui faisait exploser le budget. */
const LONG_BODY =
  'Bonjour, voici les informations relatives à votre intégration chez Kisso Industries. ' +
  'Ce corps de message est volontairement long et verbeux, comme un vrai email de bienvenue, ' +
  'et il ne doit JAMAIS revenir dans le contexte du modèle : il en est déjà l auteur.';

function makeNotification(i: number, overrides: Partial<Notification> = {}): Notification {
  const day = String(i).padStart(2, '0');
  return {
    id: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
    recipientId: RECIPIENT_ID,
    recipientType: RecipientType.Employee,
    channel: NotificationChannel.Email,
    subject: `Objet numéro ${i} — un sujet réaliste et suffisamment long pour être tronqué proprement`,
    body: LONG_BODY,
    status: NotificationStatus.Sent,
    sentAt: `2026-08-${day}T10:00:00.000Z`,
    scheduledAt: null,
    createdAt: `2026-08-${day}T09:00:00.000Z`,
    updatedAt: `2026-08-${day}T10:00:00.000Z`,
    ...overrides,
  };
}

describe('getNotificationHistory — budget et honnêteté du tool-result', () => {
  let repo: InMemoryNotificationRepository;

  beforeEach(() => {
    repo = new InMemoryNotificationRepository();
  });

  async function seed(n: number) {
    for (let i = 1; i <= n; i++) await repo.save(makeNotification(i));
  }

  async function run() {
    return (await makeGetNotificationHistory(repo).execute!(
      { recipientId: RECIPIENT_ID } as never,
      {} as never,
    )) as { notifications: Array<Record<string, unknown>>; total: number; shown: number };
  }

  it('borne le résultat et annonce le total réel', async () => {
    await seed(50);
    const result = await run();

    expect(result.notifications).toHaveLength(MAX_NOTIFICATIONS_IN_RESULT);
    expect(result.total).toBe(50);
    expect(result.shown).toBe(MAX_NOTIFICATIONS_IN_RESULT);
  });

  it('ne renvoie JAMAIS le corps du message', async () => {
    await seed(3);
    const serialise = JSON.stringify(await run());

    expect(serialise).not.toContain('Kisso Industries');
    expect(serialise).not.toContain('body');
  });

  it('ne projette que les champs utiles', async () => {
    await seed(2);
    const result = await run();

    for (const n of result.notifications) {
      expect(Object.keys(n).sort()).toEqual(['at', 'channel', 'status', 'subject']);
    }
  });

  it('rend une taille INDÉPENDANTE du nombre de notifications', async () => {
    await seed(5);
    const petit = JSON.stringify(await run()).length;

    for (let i = 6; i <= 50; i++) await repo.save(makeNotification(i));
    const grand = JSON.stringify(await run()).length;

    // Seul `total` grandit (5 → 50), soit un caractère de plus.
    expect(Math.abs(grand - petit)).toBeLessThanOrEqual(2);
  });

  it('trie du plus récent au plus ancien, de façon déterministe', async () => {
    await seed(8);
    const result = await run();

    const dates = result.notifications.map((n) => String(n.at));
    expect(dates).toEqual([...dates].sort().reverse());
    // La 8e notification est la plus récente : elle doit être en tête.
    expect(String(result.notifications[0]!.subject)).toContain('numéro 8');
  });

  it('borne aussi la longueur du sujet', async () => {
    await seed(1);
    const result = await run();

    expect(String(result.notifications[0]!.subject).length).toBeLessThanOrEqual(83);
  });

  it('date une notification enregistrée mais jamais envoyée sur sa date prévue', async () => {
    await repo.save(
      makeNotification(9, {
        status: NotificationStatus.Scheduled,
        sentAt: null,
        scheduledAt: '2026-09-01T08:00:00.000Z',
      }),
    );
    const result = await run();

    expect(result.notifications[0]!.at).toBe('2026-09-01T08:00:00.000Z');
    expect(result.notifications[0]!.status).toBe(NotificationStatus.Scheduled);
  });

  it("n'expose plus de paramètre `limit` au modèle (coût de schéma inutile)", () => {
    const shape = (makeGetNotificationHistory(repo).inputSchema as never as { shape: object })
      .shape;

    // La propriété qui compte est l'ABSENCE de `limit` : il ne servait qu'à laisser le modèle
    // choisir combien on lui facture, et la borne doit être une propriété du serveur.
    // L'assertion portait sur la liste EXACTE des clés, ce qui interdisait aussi toute clé
    // légitime — `email` a été ajouté le 2026-08-15 pour supprimer une étape entière
    // (mesuré : 3 étapes / 4 424 tokens → 2). On assert donc l'interdit, pas la liste close.
    expect(Object.keys(shape)).not.toContain('limit');
    expect(Object.keys(shape).sort()).toEqual(['email', 'recipientId']);
  });
  /**
   * ⚠️ PROPRIÉTÉ ANTI-ORACLE, identique à celle de `getEmployeeProfile`.
   *
   * Le chemin `email` doit lire pour résoudre la personne. Si le verdict différait selon que
   * l'adresse existe ou non, un demandeur non autorisé énumérerait l'annuaire une adresse à la
   * fois. L'identifiant RÉSOLU (ou `null`) est donc passé à la garde.
   */
  it('par email, ne devient pas un ORACLE pour un demandeur non autorisé', async () => {
    const { buildSlackRequestContext } = await import('../../../src/shared/slack-request-context');
    const restricted = {
      requestContext: buildSlackRequestContext({
        channel: 'D0MOCKDM01',
        slackUserId: 'U0BJBDGTJUD',
        employeeId: 'd20df236-5c24-42a5-b205-d0d738d34fb4',
        accessLevel: 'readonly',
      }),
    };
    const existe = { findByEmail: async () => ({ id: 'd36b78dc-a039-4160-b86a-bd3d2a722b6c' }) };
    const absente = { findByEmail: async () => null };

    const a = await makeGetNotificationHistory(repo, existe).execute!(
      { email: 'awa@kissohq.com' } as never,
      restricted as never,
    );
    const b = await makeGetNotificationHistory(repo, absente).execute!(
      { email: 'personne@kissohq.com' } as never,
      restricted as never,
    );

    expect((a as { reason: string }).reason).toBe('not_authorized');
    expect(b).toEqual(a);
  });
});
