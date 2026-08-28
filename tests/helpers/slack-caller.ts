import { buildSlackRequestContext } from '../../src/shared/slack-request-context';

export const CALLER_EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Un demandeur Slack identifié, au niveau `full`.
 *
 * ⚠️ Depuis le 2026-08-28, les lectures de dossier RH REFUSENT sans demandeur identifié
 * (`no_requester`). Les fixtures qui passaient `{} as never` s'appuyaient sur le fail-open de
 * `mayTouchRecord` — celui-là même que l'audit a mesuré exploitable en production. Elles
 * exercent la logique de l'outil, pas sa frontière : elles ont besoin d'un demandeur VALIDE,
 * pas d'une absence de contexte.
 *
 * Il est ici plutôt que recopié dans chaque fichier : cinq copies d'un contexte d'autorisation
 * dériveraient, et c'est la faute que ce dépôt mesure à 68 %.
 */
export const slackCaller = (
  over: { accessLevel?: 'readonly' | 'full'; employeeId?: string } = {},
) =>
  ({
    requestContext: buildSlackRequestContext({
      channel: 'D0TESTCALLER',
      slackUserId: 'U0TESTCALLER',
      employeeId: over.employeeId ?? CALLER_EMPLOYEE_ID,
      accessLevel: over.accessLevel ?? 'full',
    }),
  }) as never;
