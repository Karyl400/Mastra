import { describe, it, expect, vi } from 'vitest';

import { makeUpdateOnboardingStatus } from '../../../src/features/onboarding/application/tools/update-onboarding-status';
import { makeScheduleReminder } from '../../../src/features/notification/application/tools/schedule-reminder';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';
import { OnboardingStatus } from '../../../src/shared/types';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LES DEUX ÉCRIVAINS QUI N'AVAIENT AUCUNE GARDE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Relevé le 2026-08-18 :
 * `grep -c 'canPerformSideEffects|canReadPersonRecord|readSlackContext'` rendait **0** pour
 * `update-onboarding-status.ts` et `schedule-reminder.ts`, contre **2** pour
 * `send-notification.ts`. C'étaient les deux SEULS outils exposés à un agent qui écrivent en
 * base sans regarder qui demande.
 *
 * Ce que cela permettait, concrètement :
 *  • `updateOnboardingStatus` accepte un `employeeId` que le MODÈLE produit à partir d'un
 *    texte Slack arbitraire, et pose `completedAt` quand le statut vaut `Completed`. Un
 *    invité mono-canal pouvait donc déclarer terminé le parcours d'intégration d'un tiers —
 *    et le seul suivi que ce produit sache réellement observer est justement celui-là.
 *  • `scheduleReminder` écrit un `subject` et un `body` (jusqu'à 5 000 caractères) dans
 *    `notifications`, sur le `recipientId` d'un tiers. Ces lignes ressortent ensuite par
 *    `getNotificationHistory` : c'est une écriture arbitraire dans l'historique de
 *    quelqu'un d'autre.
 *
 * ⚠️ CES TESTS PORTENT SUR LE CÂBLAGE, pas sur la décision. `canPerformSideEffects` a ses
 * propres tests ; ils ne prouvent rien sur le comportement d'un outil qui ne l'appelle pas.
 * C'est la classe de défaut la plus fréquente de ce dépôt — deux bords corrects, aucun
 * câblage entre les deux — et c'est exactement ce qui s'était produit ici.
 *
 * On vérifie donc que **le repository n'est JAMAIS touché** : un test qui regarderait
 * seulement le résultat laisserait passer une implémentation qui écrit d'abord et filtre
 * ensuite.
 *
 * ⚠️ Rappel de portée : cette frontière hérite du mode observation. Tant qu'`AUTHZ_ENFORCE`
 * n'est pas posé, `SlackAccessGuard` rend `full` à tout le monde et ces refus ne se
 * produiront pas en production. Le câblage est là ; c'est son activation qui reste à décider.
 */

const SOMEONE_ELSE = 'd36b78dc-a039-4160-b86a-bd3d2a722b6c';

/** Demandeur réel, identifié, mais SANS le niveau `full`. */
const restricted = {
  requestContext: buildSlackRequestContext({
    channel: 'D0MOCKDM01',
    slackUserId: 'U0BJBDGTJUD',
    employeeId: 'd20df236-5c24-42a5-b205-d0d738d34fb4',
    accessLevel: 'readonly',
  }),
};

describe('updateOnboardingStatus — frontière d’autorisation', () => {
  it('REFUSE sans jamais lire ni écrire le suivi', async () => {
    const findByEmployee = vi.fn();
    const update = vi.fn();
    const tool = makeUpdateOnboardingStatus({ findByEmployee, update } as never);

    const result = (await tool.execute!(
      { employeeId: SOMEONE_ELSE, status: OnboardingStatus.Completed } as never,
      restricted as never,
    )) as { updated: boolean; reason?: string };

    expect(result.updated).toBe(false);
    expect(result.reason).toBe('not_authorized');
    expect(findByEmployee).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('laisse passer un appel HORS Slack — workflow, playground, test', async () => {
    // L'absence de niveau vaut autorisation, comme pour `sendNotification` : hors Slack il
    // n'y a pas de demandeur à évaluer, et refuser casserait le parcours d'onboarding.
    const findByEmployee = vi.fn().mockResolvedValue(null);
    const tool = makeUpdateOnboardingStatus({ findByEmployee, update: vi.fn() } as never);

    const result = (await tool.execute!(
      { employeeId: SOMEONE_ELSE, status: OnboardingStatus.InProgress } as never,
      {} as never,
    )) as { updated: boolean; reason?: string };

    expect(findByEmployee).toHaveBeenCalled();
    expect(result.reason).toBe('no_onboarding_progress');
  });
});

describe('scheduleReminder — frontière d’autorisation', () => {
  const reminder = {
    recipientId: SOMEONE_ELSE,
    subject: 'Compléter ton profil',
    body: 'Un petit mot pour te le rappeler.',
    scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
  };

  it('REFUSE sans jamais écrire en base', async () => {
    const save = vi.fn();
    const findById = vi.fn().mockResolvedValue({ id: SOMEONE_ELSE, email: 'awa@kissohq.com' });
    const tool = makeScheduleReminder({ save } as never, { findById } as never);

    const result = (await tool.execute!(reminder as never, restricted as never)) as {
      stored: boolean;
      reason?: string;
    };

    expect(result.stored).toBe(false);
    expect(result.reason).toBe('not_authorized');
    expect(save).not.toHaveBeenCalled();
    // Le destinataire n'est pas même RÉSOLU : sans cela le refus deviendrait un oracle
    // d'existence, exactement le défaut fermé sur `getEmployeeProfile`.
    expect(findById).not.toHaveBeenCalled();
  });

  it('laisse passer un appel HORS Slack', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const findById = vi.fn().mockResolvedValue({ id: SOMEONE_ELSE, email: 'awa@kissohq.com' });
    const tool = makeScheduleReminder({ save } as never, { findById } as never);

    const result = (await tool.execute!(reminder as never, {} as never)) as { stored: boolean };

    expect(result.stored).toBe(true);
    expect(save).toHaveBeenCalled();
  });
});
