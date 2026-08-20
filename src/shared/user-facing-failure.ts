/**
 * Traduction d'une panne technique en une phrase que quelqu'un peut lire.
 *
 * ## Pourquoi dans `shared/`
 *
 * Extrait de `slack-events.handler.ts` le 2026-08-17. Ce n'est pas de l'infrastructure
 * Slack : c'est la politique de ce que le produit DIT quand il échoue, et elle vaut pour
 * tout canal de sortie. La laisser dans le handler la rendait invisible depuis la route
 * d'interactivité, qui affiche pourtant ses propres échecs.
 *
 * La distinction qu'elle porte est la seule qui compte pour l'utilisateur : un quota épuisé
 * est le SEUL échec où réessayer a un sens. Le message générique laissait croire à une panne,
 * et l'utilisatrice testeuse a conclu à un bug puis est passée au message suivant — qui a
 * échoué pour la même raison.
 */

import { logger } from './logger';
import { securityRefusalMessage } from './security/llm-guardrail';

/**
 * Message générique, quand on ne sait rien dire de plus précis que « ça a raté ».
 *
 * ⚠️ RÉÉCRIT le 2026-08-14. L'ancienne rédaction — « Désolé, je n'ai pas réussi à traiter
 * ton message. » — laissait la personne sans aucune indication : elle ne disait ni de quel
 * CÔTÉ était le problème, ni quoi faire. Deux effets mesurés dans les transcrits : on
 * reformule sa demande (inutile, la panne est serveur) ou on abandonne.
 *
 * Ce qu'il dit désormais, et qui est vrai dans TOUS les cas où il est posté : la panne est
 * de notre côté, réessayer a un sens, et une récurrence est un vrai défaut. Il ne promet
 * aucune transmission — rien dans ce système n'alerte qui que ce soit.
 */
export const GENERIC_FAILURE =
  'Quelque chose a cassé de mon côté — ça ne vient pas de ta demande. Réessaie, et si ça ' +
  'recommence, remonte-le : je ne peux pas me réparer tout seul.';

/**
 * Message posté quand les DEUX fournisseurs de modèle ont refusé la requête.
 *
 * Distinguer ce cas n'est pas du confort : c'est le seul échec où **réessayer a un sens**,
 * et le générique laissait croire à une panne. Mesuré en production le 2026-08-11 à
 * 18:21:50 UTC — Groq sur son quota JOURNALIER (`TPD: Limit 100000, Used 98207`, et non le
 * seau par minute, qui était plein) puis Mistral sur ses 4 requêtes/minute. L'utilisateur a
 * conclu à un bug et est passé au message suivant, qui a échoué pour la même raison.
 *
 * ⚠️ La seconde phrase a été ajoutée le 2026-08-14, et elle corrige une INEXACTITUDE.
 * « Réessaie dans quelques minutes » est vrai pour le seau par MINUTE, faux pour le plafond
 * JOURNALIER — qui est celui qui casse réellement la production (`TPD: Limit 100000`, soit
 * ≈ 19 messages/jour). Vérifié le 2026-08-11 : réessayé après 60 s, même échec, en 21 s.
 * Conseiller d'attendre quelques minutes dans ce cas-là, c'est envoyer quelqu'un se heurter
 * douze fois au même mur.
 */
export const QUOTA_FAILURE =
  "Je n'ai plus de quota chez mes fournisseurs de modèle. Réessaie dans quelques minutes — " +
  "et si ça persiste, c'est le plafond de la journée qui est atteint : ça repartira demain.";

/**
 * Message posté quand l'appel au modèle a dépassé sa borne de durée.
 *
 * ⚠️ DISTINCT du générique, et ce n'est pas du confort. Le générique dit « remonte-le : je
 * ne peux pas me réparer tout seul » — sur un délai dépassé c'est faux et coûteux : la
 * cause est presque toujours transitoire (fournisseur lent, démarrage à froid, bascule vers
 * le repli), et réessayer aboutit souvent. Inviter à signaler un défaut là où il fallait
 * simplement réessayer est exactement l'erreur commise sur le quota avant `QUOTA_FAILURE`,
 * et elle a été mesurée : l'utilisatrice a conclu à un bug et est passée au message suivant.
 *
 * Il ne promet rien qu'on ne tienne : le travail est réellement abandonné à ce stade, et
 * aucun mécanisme ne le reprend — ce dépôt n'a ni cron, ni file, ni retry.
 */
export const TIMEOUT_FAILURE =
  "Je n'ai pas réussi à répondre dans le temps qui m'est imparti — je n'ai donc rien fait. " +
  'Réessaie : ça passe le plus souvent au coup suivant.';

/**
 * Traduit une exception en message destiné à la personne.
 *
 * Volontairement **conservateur** : tout ce qui n'est pas reconnu avec certitude reste
 * générique. Se tromper de diagnostic est pire que ne pas en donner — inviter à réessayer
 * une requête qui échouera toujours fait perdre du temps ET du quota.
 *
 * La reconnaissance porte sur le `name` du SDK (`AI_APICallError`) et sur un
 * `statusCode`/`status` à 429, jamais sur le seul texte du message : la prose d'erreur
 * change d'une version de fournisseur à l'autre, le code HTTP non. La chaîne `cause` est
 * suivie car `withChainFailureLogging` réemballe l'échec du dernier maillon.
 */
export function userFacingFailure(error: unknown): string {
  // Un message BLOQUÉ par le garde-fou n'est pas une panne, et le dire « Désolé, je n'ai pas
  // réussi à traiter ton message » était doublement faux : rien n'a échoué, et réessayer à
  // l'identique ne servira à rien. `NEUTRAL_REFUSAL` reste muet sur la règle touchée —
  // renseigner l'auteur sur la sonde qui a porté est précisément le défaut corrigé sur
  // `[SECURITY_BLOCK]`.
  const refusal = securityRefusalMessage(error);
  if (refusal) return refusal;

  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as {
      name?: unknown;
      statusCode?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    const status = candidate.statusCode ?? candidate.status;
    if (status === 429) return QUOTA_FAILURE;

    // ⚠️ Reconnu sur le `name`, jamais sur le texte — même arbitrage que pour le quota.
    // `AbortSignal.timeout` pose `TimeoutError` (`DOMException`) ; plusieurs couches du SDK
    // et de Node rendent `AbortError` pour une annulation. Les deux désignent ici la MÊME
    // cause : notre propre borne a mordu, puisque rien d'autre dans ce dépôt n'annule un
    // appel en cours.
    if (candidate.name === 'TimeoutError' || candidate.name === 'AbortError') {
      return TIMEOUT_FAILURE;
    }
    if (candidate.name === 'AI_APICallError' || candidate.name === 'APICallError') {
      // Le SDK n'expose pas toujours le code : à ce stade le message est le seul indice,
      // et « rate limit » y est stable chez Groq comme chez Mistral.
      if (/rate limit|quota/i.test(String((candidate as { message?: unknown }).message ?? ''))) {
        return QUOTA_FAILURE;
      }
    }
    current = candidate.cause;
  }

  // ⚠️ INSTRUMENTATION, pas correctif — posée le 2026-08-19 après un échec de production que
  // ce détecteur AURAIT dû reconnaître. Les logs montraient
  // `AI_APICallError: Rate limit reached … (TPM): Limit 8000`, et l'utilisateur a pourtant reçu
  // le message GÉNÉRIQUE (« quelque chose a cassé de mon côté »), qui invite à SIGNALER là où
  // il fallait RÉESSAYER. C'est le seul échec où réessayer a un sens, et c'est celui qu'on
  // décrit comme une panne.
  //
  // La cause n'est pas établie et on ne la devine pas : l'erreur qui parvient ici est celle du
  // DERNIER maillon (Mistral), pas de Groq dont l'échec est journalisé séparément, et
  // `CLAUDE.md` documente que Mastra réemballe avec `name: 'Error'`. Élargir le motif au seul
  // texte du message contredirait l'arbitrage écrit dix lignes plus haut — « jamais sur le seul
  // texte, la prose change d'une version à l'autre, le code HTTP non ».
  //
  // On journalise donc la FORME réelle de la chaîne, pour que le prochain échec la donne au
  // lieu de la faire supposer.
  logger.warn('Échec non classé — le message générique va être rendu', {
    chain: describeErrorChain(error),
  });

  return GENERIC_FAILURE;
}

/** La forme de la chaîne d'erreurs, sans jamais son contenu métier. */
function describeErrorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  for (let current: unknown = error, depth = 0; current && depth < 6; depth += 1) {
    const c = current as {
      name?: unknown;
      message?: unknown;
      statusCode?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    chain.push({
      name: String(c.name ?? ''),
      status: c.statusCode ?? c.status ?? null,
      // Borné : c'est une empreinte de forme, pas un dépotoir. Assez pour reconnaître
      // « rate limit », jamais assez pour transporter une donnée personnelle.
      message: String(c.message ?? '').slice(0, 160),
    });
    current = c.cause;
  }
  return chain;
}
