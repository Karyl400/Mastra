/**
 * ════════════════════════════════════════════════════════════════════════════
 * L'APPARTENANCE AU WORKSPACE — une règle, deux portes d'entrée
 * ════════════════════════════════════════════════════════════════════════════
 *
 * La signature HMAC prouve que **Slack** a émis la requête. Elle ne dit rien de **quel
 * workspace** : une app installée ailleurs signerait tout aussi valablement. `SLACK_TEAM_ID`
 * est la défense en profondeur qui tranche cette question.
 *
 * ⚠️ **Elle n'existait que d'un côté.** `SlackEventsHandler.checkTeamId` la posait sur
 * `/slack/events` ; `/slack/interactions` ne la posait pas, alors que le champ `team.id` est
 * déclaré dans son type de payload et **lu nulle part**. L'audit du 2026-08-21 l'a relevé.
 *
 * ⚠️ **On PARTAGE la fonction plutôt que de la recopier**, et c'est la leçon la plus chère de
 * ce dépôt : « deux machines à états qui suivent la même règle sans la partager finissent par
 * diverger, et c'est celle qu'on a oubliée qui perd les données ». Elle a été payée le
 * 2026-08-21 sur `profileRetryReply` / `pendingInterviewStep`.
 *
 * ⚠️ **FAIL-OPEN, à dessein et comme avant.** Sans `SLACK_TEAM_ID`, on n'écarte rien : la
 * variable est facultative, et un déploiement qui ne l'a pas posée doit continuer de servir son
 * workspace. Le refus silencieux de TOUS les événements serait une panne indiscernable d'un bot
 * mort — précisément ce que ce dépôt combat.
 */

export type WorkspaceVerdict =
  | { readonly accepted: true; readonly checked: boolean }
  | { readonly accepted: false; readonly received: string; readonly expected: string };

export function judgeWorkspace(
  teamId: string | undefined | null,
  expected: string | undefined | null,
): WorkspaceVerdict {
  const want = expected?.trim();
  // Non configurée : on ne vérifie pas, et l'appelant journalise UNE fois que le contrôle dort.
  if (!want) return { accepted: true, checked: false };

  const got = teamId?.trim();
  // ⚠️ Un événement SANS `team_id` est accepté : le champ est absent de certaines charges
  // Slack, et le refuser transformerait une défense en profondeur en panne intermittente.
  if (!got) return { accepted: true, checked: true };

  if (got !== want) return { accepted: false, received: got, expected: want };
  return { accepted: true, checked: true };
}
