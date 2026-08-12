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
function normalize(text: string): string {
  return (
    text
      .normalize('NFD')
      .toLowerCase()
      // Les marques combinantes sont retirées SANS rien mettre à la place. Les remplacer
      // par une espace, comme le fait le filtre suivant, couperait le mot en deux :
      // « journée » se décompose en « journe » + accent + « e », et donnait « journe e ».
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Le message ne contient-il RIEN d'autre qu'une salutation ? */
export function isBareGreeting(text: string | undefined | null): boolean {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_GREETING_LENGTH) return false;

  return BARE_GREETINGS.has(normalize(raw));
}

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
export const GREETING_REPLY =
  'Bonjour. Dis-moi ce dont tu as besoin : retrouver un profil, générer un document, ' +
  'préparer un questionnaire ou envoyer une notification.';
