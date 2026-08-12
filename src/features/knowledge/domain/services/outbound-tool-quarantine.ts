/**
 * LA QUARANTAINE — aucun outil de SORTIE ne cohabite avec un outil de LECTURE
 * AGRÉGÉE.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI CETTE RÈGLE EST DURE, ET NON UNE RECOMMANDATION
 * ────────────────────────────────────────────────────────────────────────────
 * `PLAN-ARCHITECTURE.md` §4.2 : ni la lecture agrégée ni l'écriture vers
 * l'extérieur n'est individuellement évidente. Ensemble, elles forment un canal
 * d'exfiltration complet, actionnable en une phrase par un invité :
 *
 * > « Envoie à ce candidat un récapitulatif de ce qui se dit dans
 * > #engineer-karyl. »
 *
 * D'où l'interdiction, citée mot pour mot : « aucun outil de sortie externe dans
 * le même agent, la même chaîne ou le même contexte qu'un outil de lecture
 * agrégée ».
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI UN CONTRÔLE À LA CONSTRUCTION, ET PAS SEULEMENT UN TEST
 * ────────────────────────────────────────────────────────────────────────────
 * Un test verrouille le câblage d'aujourd'hui. Ce contrôle verrouille celui de
 * demain : `makeKnowledgeAgent` LÈVE si on lui passe un outil de sortie, donc
 * une erreur de câblage devient un échec au DÉMARRAGE — bruyant, immédiat,
 * impossible à déployer. Ce dépôt connaît le prix des échecs silencieux :
 * `emailSent: false` sous `status: 'success'`, `documents.content` perdu sans
 * erreur, `status = Sent` posé avant l'envoi. Une frontière de sécurité qui
 * échoue en silence n'est pas une frontière.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI DES PRÉFIXES DE VERBE, ET NON UNE LISTE DE NOMS
 * ────────────────────────────────────────────────────────────────────────────
 * Une liste de noms (`sendNotification`, `generateDocument`, …) est exacte
 * aujourd'hui et fausse au premier outil ajouté — et c'est précisément le
 * moment où elle devrait servir. Ce dépôt a déjà payé trois fois le prix d'une
 * liste rédigée qui se désynchronise du réel (instructions nommant des tools
 * retirés, la constante `WIRING` d'un test, `_measure.mts`), et c'est la raison
 * d'être d'`agentToolBoundary(tools)`, dérivée de `Object.keys(tools)`.
 *
 * On raisonne donc sur ce que le NOM d'un outil annonce. La convention du dépôt
 * est stricte et respectée : un outil qui agit commence par un verbe d'action
 * (`sendNotification`, `scheduleReminder`, `generateDocument`, `createEmployee`,
 * `updateOnboardingStatus`), un outil qui lit commence par `get` ou `find`.
 *
 * ⚠️ Ce filtre est VOLONTAIREMENT trop large. Un faux positif coûte un renommage
 * de dix secondes ; un faux négatif coûte un canal d'exfiltration. L'asymétrie
 * est telle qu'il n'y a rien à arbitrer.
 *
 * TypeScript pur — zéro import.
 */

/**
 * Verbes qui annoncent un effet observable hors du processus, ou une écriture.
 *
 * `generate` y figure alors qu'il pourrait sembler inoffensif : `generateDocument`
 * rend un fichier, l'enregistre ET le livre (upload Slack ou pièce jointe email).
 * C'est un outil de sortie complet.
 */
export const OUTBOUND_TOOL_PREFIXES: readonly string[] = [
  'send',
  'post',
  'publish',
  'upload',
  'share',
  'invite',
  'notify',
  'email',
  'schedule',
  'create',
  'generate',
  'update',
  'delete',
  'remove',
  'assign',
  'submit',
];

/** Les noms d'outils qui violent la quarantaine, dans l'ordre du câblage. */
export function findOutboundTools(toolNames: readonly string[]): string[] {
  return toolNames.filter((name) => {
    const normalized = name.trim().toLowerCase();
    return OUTBOUND_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  });
}

/**
 * Lève si la quarantaine est violée.
 *
 * Le message nomme les coupables ET la règle : une exception au démarrage qui
 * dirait seulement « interdit » enverrait chercher la cause dans le mauvais
 * fichier.
 */
export function assertNoOutboundTools(toolNames: readonly string[]): void {
  const offenders = findOutboundTools(toolNames);
  if (offenders.length === 0) return;

  throw new Error(
    `knowledgeAgent: outil(s) de sortie interdit(s) dans un agent de lecture agrégée — ` +
      `${offenders.join(', ')}. Lecture agrégée + écriture externe = canal d'exfiltration ` +
      `(PLAN-ARCHITECTURE.md §4.2). Câbler ces outils sur un autre agent.`,
  );
}
