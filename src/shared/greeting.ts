/**
 * Reconnaissance d'une SALUTATION NUE — court-circuit déterministe, zéro appel LLM.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le défaut mesuré en production le 2026-08-12 à 21:58 UTC
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le mot « Bonjour », sept caractères, a produit ceci :
 *
 *   toolCalls: ["findEmployeeByEmail","getEmployeeProfile","updateOnboardingStatus","getTaskList"]
 *   steps: 5, inputTokens: 13376
 *
 * Deux dégâts distincts, chacun suffisant :
 *   1. **une tentative d'ÉCRITURE non demandée** — `updateOnboardingStatus` a poussé le
 *      dossier de la personne en `in_progress` parce qu'elle avait dit bonjour ;
 *   2. **13 376 tokens**, soit 13 % du budget Groq quotidien (100 000/jour) pour une
 *      salutation. Le poste de coût dominant de ce dépôt est le NOMBRE D'ÉTAPES, et
 *      celle-ci en a consommé cinq pour zéro information demandée.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi du code et non une consigne de prompt
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Une ligne d'instruction (« ne déclenche aucun outil sur une salutation ») serait payée
 * à CHAQUE aller-retour de CHAQUE message, y compris les milliers qui ne sont pas des
 * salutations, et resterait probabiliste — le modèle vient précisément de démontrer qu'il
 * préfère agir. Ici le coût est nul et la garantie est totale.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le critère : ÉGALITÉ, jamais « commence par »
 * ════════════════════════════════════════════════════════════════════════════
 *
 * « Bonjour, que peux-tu faire pour moi ? » et « Salut, tu peux me retrouver le profil
 * de … ? » sont de VRAIES demandes qui commencent par une salutation — les court-circuiter
 * serait bien pire que le défaut corrigé. Seul un message qui ne contient RIEN d'autre
 * qu'une formule de politesse est intercepté. C'est aussi pourquoi la liste est fermée et
 * courte : chaque entrée est un message auquel le bot cessera de réfléchir.
 */

import { normalizeIntentText } from './intent-text';

/** Formules acceptées, sous forme NORMALISÉE (minuscules, sans accent ni ponctuation). */
const BARE_GREETINGS = new Set([
  'bonjour',
  'bonsoir',
  'salut',
  'coucou',
  'hello',
  'hey',
  'hi',
  'yo',
  're',
  'bonjour a tous',
  'bonjour a toutes et a tous',
  'salut a tous',
  'bonne journee',
  'bonne soiree',

  // ══════════════════════════════════════════════════════════════════════════
  // SONDES DE VIE — ajoutées le 2026-08-13
  // ══════════════════════════════════════════════════════════════════════════
  // Ce ne sont pas des salutations, mais elles appellent exactement la même réponse : « le
  // bot est vivant, voici ce qu'il sait faire ». Les laisser passer coûtait un run LLM
  // complet — ≈ 5 % du budget quotidien — pour un mot sans contenu.
  //
  // ⚠️ « test » était PIRE qu'un simple gaspillage : c'est un mot-clé de routage
  // (`QUESTIONNAIRE_TOPICS`), donc quelqu'un qui tapait « test » pour voir si le bot vivait
  // atterrissait chez `questionnaireEngine`, qui lui demandait pour qui créer une
  // évaluation. Le critère d'ÉGALITÉ STRICTE de ce module garantit que « ceci est un test »
  // ou « envoie-lui le test » ne sont pas capturés, et que l'entrée thématique reste vivante
  // pour les vraies phrases.
  // ⚠️ « ok » et « d'accord » sont VOLONTAIREMENT absents : ce sont des CONFIRMATIONS, pas
  // des sondes. Les intercepter casserait « tu veux que je l'envoie ? » → « ok », qui doit
  // atteindre l'agent pour qu'il agisse. C'est la même distinction que celle qui a fait
  // écarter « ajoute » du palier d'échappement : le critère n'est pas « le mot est court »
  // mais « le message n'attend rien du système ».
  'test',
  'ping',
  '123',
]);

/**
 * Borne de longueur AVANT toute normalisation coûteuse.
 *
 * La plus longue formule acceptée fait 26 caractères ; on laisse de la marge pour la
 * ponctuation et un emoji. Au-delà, c'est une phrase, donc une demande.
 */
const MAX_GREETING_LENGTH = 40;

/**
 * Normalise pour comparaison : minuscules, accents retirés, ponctuation et emojis retirés,
 * espaces réduits.
 *
 * ⚠️ Pas de classe Unicode `\p{L}` dans une regex de ce dépôt côté schémas de tools (zod
 * épinglé) — ici on est hors schéma, mais on s'en tient malgré tout à des classes ASCII
 * après décomposition NFD, comme `document-file.ts`. La décomposition transforme « é » en
 * « e » + diacritique, et le filtre `[a-z ]` fait le reste : liste blanche, jamais noire.
 */

/** Le message ne contient-il RIEN d'autre qu'une salutation ? */
export function isBareGreeting(text: string | undefined | null): boolean {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_GREETING_LENGTH) return false;

  return BARE_GREETINGS.has(normalizeIntentText(raw));
}

/**
 * Ce que la salutation ANNONCE, et l'outil qui le sert réellement.
 *
 * ⚠️ **Cette table existe à cause d'un défaut trouvé le 2026-08-18 : la salutation proposait
 * « préparer un questionnaire ».** La feature `questionnaire` a été supprimée du dépôt le
 * 2026-08-14 — agent retiré du registre, outils supprimés, tables laissées en production.
 * Le tout PREMIER message que lit un utilisateur promettait donc une capacité qui n'existe
 * plus, et personne ne l'avait vu : ce texte est un littéral, rien ne le reliait au câblage.
 *
 * Chaque entrée porte donc le nom de l'outil qui la rend vraie, et un test vérifie que cet
 * outil est bien câblé sur un agent (`shared/agent-capabilities.ts`). Le jour où un outil
 * disparaît, c'est un test qui rougit — plus une promesse creuse qui survit des semaines.
 * C'est la même discipline que la frontière négative des agents : ne jamais rédiger à la
 * main ce que le câblage peut prouver.
 */
export const ANNOUNCED_CAPABILITIES: ReadonlyArray<{
  readonly text: string;
  readonly tool: string;
}> = [
  { text: "retrouver le profil de quelqu'un", tool: 'getEmployeeProfile' },
  { text: 'préparer un document', tool: 'generateDocument' },
  { text: 'envoyer un message', tool: 'sendNotification' },
  { text: "résumer ce qui s'est dit dans un canal", tool: 'getChannelHistory' },
];

/**
 * Réponse rendue à une salutation nue.
 *
 * Elle ORIENTE au lieu de saluer en retour : quelqu'un qui écrit « bonjour » à un bot
 * attend de savoir quoi lui demander. C'est la seule réponse du système qui énumère des
 * capacités — le bloc STYLE l'interdit aux agents précisément parce qu'ils le faisaient
 * au milieu d'une vraie réponse ; ici il n'y a pas d'autre contenu à protéger.
 *
 * Volontairement sans question ouverte finale : la personne va enchaîner de toute façon,
 * et chaque tour supplémentaire coûte un vrai appel LLM.
 */
const CAPABILITY_LIST = `${ANNOUNCED_CAPABILITIES.slice(0, -1)
  .map((c) => c.text)
  .join(', ')}, ou ${ANNOUNCED_CAPABILITIES[ANNOUNCED_CAPABILITIES.length - 1]!.text}`;

export const GREETING_REPLY = `Bonjour. Dis-moi ce dont tu as besoin : ${CAPABILITY_LIST}.`;

/**
 * Les formulations possibles. La première EST `GREETING_REPLY` — c'est la canonique, celle que
 * les tests et la documentation citent, et celle rendue hors Slack.
 *
 * ⚠️ Toutes annoncent la MÊME liste de capacités, dérivée d'`ANNOUNCED_CAPABILITIES` : une
 * variante qui en oublierait une, ou en inventerait une, rouvrirait exactement le défaut que
 * cette table vient de fermer. Ce qui varie est l'ATTAQUE de la phrase, rien d'autre.
 *
 * Pourquoi c'est ici que ça compte le plus : la salutation est, de très loin, la réponse la
 * plus répétée du produit — et la répétition littérale est ce qui fait « machine ».
 */
export const GREETING_REPLIES: readonly string[] = [
  GREETING_REPLY,
  `Bonjour. Je peux ${CAPABILITY_LIST}. Qu'est-ce qu'il te faut ?`,
  `Salut. Dis-moi ce que tu cherches : ${CAPABILITY_LIST}.`,
];
