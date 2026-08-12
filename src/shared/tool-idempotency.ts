/**
 * Garde d'idempotence à l'échelle d'un RUN, pour les tools à effet de bord VISIBLE.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le défaut qu'elle corrige, mesuré en production le 2026-08-12 à 19:42 UTC
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Un seul message Slack (« Génère-moi un message de bienvenue pour Karyl en PDF »),
 * et cette trace :
 *
 *   toolCalls: ["generateDocument","findEmployeeByEmail","getEmployeeProfile","generateDocument"]
 *   steps: 3, inputTokens: 7804
 *
 * Deux lignes dans `documents` (`3f1399e2…` et `d05ff0cf…`), deux uploads Slack réussis,
 * deux pièces jointes dans le fil — pour une seule réponse texte. Le propriétaire l'a
 * signalé comme « il envoie deux fois le même PDF pour une seule requête ».
 *
 * Ce n'est ni un rejeu d'événement Slack (`slack_event_dedup` a bien fait son travail : une
 * seule réponse texte, un seul marqueur de progression), ni une reprise du SDK Slack : c'est
 * le MODÈLE qui a appelé le tool deux fois dans le même run. Mastra 1.57 autorise jusqu'à
 * 5 étapes par défaut (`stopWhen ?? stepCountIs(5)`) et ne déduplique pas les appels d'outils.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi une garde de CODE et non une consigne de prompt
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Une phrase d'instruction (« n'appelle generateDocument qu'une fois ») est repayée à chaque
 * aller-retour sous un quota de ≈ 19 messages/jour, et reste probabiliste. Une garde
 * déterministe coûte zéro token et rend le doublon structurellement impossible.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Ce que la clé contient — et surtout ce qu'elle NE contient PAS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * La clé décrit le LIVRABLE, jamais la prose. Dans l'incident, les deux appels portaient le
 * même `employeeId`, le même `type` et le même `title`, mais un `content` DIFFÉRENT (15 puis
 * 249 caractères — le modèle a étoffé son texte au second passage). Hacher tous les arguments
 * n'aurait donc rien attrapé. On retient l'identité de ce qui est livré — destinataire, type,
 * titre, format, canal de livraison — et on ignore le contenu rédigé.
 *
 * Conséquence assumée : le second contenu, plus riche, est perdu. C'est le bon arbitrage —
 * l'utilisateur a demandé UN document, et deux pièces jointes dans un fil sont un défaut
 * visible, là où un texte légèrement plus court ne l'est pas.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Portée : en MÉMOIRE, volontairement
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le doublon visé naît de deux appels d'outil DANS LE MÊME RUN, donc dans le même processus.
 * Un store partagé (comme `slack_event_dedup`) serait ici une E/S par appel de tool pour un
 * cas que la mémoire tranche déjà — et l'inter-instance est un problème distinct, celui du
 * rejeu d'événement, déjà résolu ailleurs. La leçon « le LRU en mémoire ne suffit pas » de
 * `slack_event_dedup` ne s'applique PAS : là-bas les deux invocations étaient sur des
 * instances différentes par construction ; ici elles ne peuvent pas l'être.
 *
 * Le TTL et le plafond de taille existent parce que Vercel Fluid Compute réutilise les
 * instances entre requêtes : sans eux, la carte croîtrait sur toute la vie de l'instance.
 */

/** Au-delà, l'appel n'appartient plus au même run : un run dépasse rarement 21 s. */
const RUN_GUARD_TTL_MS = 2 * 60 * 1000;

/** Plafond de sécurité — l'instance est réutilisée entre requêtes. */
const RUN_GUARD_MAX_ENTRIES = 200;

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
}

export interface RunGuard {
  /** Le résultat déjà produit pour cette clé dans ce run, ou `undefined`. */
  get<T>(key: string): T | undefined;
  /** Mémorise le résultat produit. */
  remember(key: string, value: unknown): void;
}

export function makeRunGuard(now: () => number = Date.now): RunGuard {
  const entries = new Map<string, Entry>();

  const evictExpired = (at: number): void => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key);
    }
  };

  return {
    get<T>(key: string): T | undefined {
      const at = now();
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= at) {
        entries.delete(key);
        return undefined;
      }
      return entry.value as T;
    },

    remember(key: string, value: unknown): void {
      const at = now();
      evictExpired(at);
      // Map conserve l'ordre d'insertion : la plus ancienne clé est la première.
      while (entries.size >= RUN_GUARD_MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      entries.set(key, { value, expiresAt: at + RUN_GUARD_TTL_MS });
    },
  };
}

/**
 * Clé de run, ou `undefined` quand il n'y en a pas.
 *
 * ⚠️ `undefined` DÉSACTIVE la garde, et c'est voulu : hors Slack (playground, workflow,
 * test, route HTTP) il n'y a pas de run à borner, et se rabattre sur une clé constante
 * ferait qu'un second appel légitime — dans un tout autre contexte — récupérerait le
 * résultat du premier. Mieux vaut pas de garde qu'une garde qui confond deux runs.
 *
 * `eventTs` est l'identifiant du message Slack traité : unique par message, DM compris,
 * là où `channel` seul est partagé par toute une conversation directe.
 */
export function buildRunKey(
  eventTs: string | undefined,
  toolId: string,
  parts: ReadonlyArray<string | null | undefined>,
): string | undefined {
  if (!eventTs) return undefined;
  // Séparateur NUL : un titre est rédigé par le modèle et contient espaces, ':' et '|'.
  // Tout séparateur imprimable rendrait ('Guide','A') et ('Guide:A','') identiques ; NUL
  // est le seul caractère qu'aucune de ces parties ne peut porter.
  return [eventTs, toolId, ...parts.map((p) => p ?? '')].join('\u0000');
}
