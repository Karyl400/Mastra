import type { Client, InArgs, InStatement, ResultSet } from '@libsql/client';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA REPRISE SUR TURSO, ÉCRITE UNE SEULE FOIS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **CE MODULE EXISTE PARCE QUE LE DÉPÔT AVAIT DÉJÀ ÉCRIT SA PROPRE LEÇON SANS L'APPLIQUER.**
 *
 * `probe-erasure.mts` porte, depuis le 2026-08-21, ce commentaire :
 *
 *   « Deux sondes qui frappent la même base sans partager leur reprise finissent par
 *     diverger, et c'est celle qu'on a oubliée qui perd le verdict. »
 *
 * La phrase était juste et la reprise est restée recopiée. Relevé le 2026-08-22 : QUATRE
 * scripts ouvraient un client libsql sans aucune reprise — `probe-authz`, `probe-knowledge`,
 * `knowledge-forget`, `knowledge-status`. Le même jour, trois sondes ont été tuées en vol par
 * un `UND_ERR_CONNECT_TIMEOUT` vers `turso.io`, dont `probe-authz` au milieu de son relevé.
 *
 * ⚠️ **CE QUE COÛTE VRAIMENT L'ABSENCE DE REPRISE N'EST PAS UN ÉCHEC, C'EST UN SILENCE.**
 * Une sonde tuée ne rend pas un verdict « rouge » : elle ne rend AUCUN verdict, et l'on est
 * tenté de lire son interruption comme un succès partiel. Pire, si elle a déjà ÉCRIT en
 * production — c'est le cas de `probe-erasure` et de `probe-arrival` — on a modifié la base
 * sans pouvoir dire ce qui s'est passé. C'est exactement le mode de panne que ce dépôt traque
 * dans le produit, reproduit dans son outillage.
 *
 * ⚠️ **LA REPRISE DOIT COUVRIR LES DEUX BORDS.** La première version de `probe-arrival`
 * enveloppait ses appels HTTP et laissait la requête Turso nue ; celle de
 * `probe-distress-boundary` a refait la même faute le 2026-08-22, dans cet ordre exact. Un
 * réseau instable ne choisit pas quel bord il coupe.
 */

const ATTEMPTS = 4;
const BACKOFF_MS = 1_500;

export async function retry<T>(operation: () => Promise<T>, attempts = ATTEMPTS): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * ⚠️ Elle prend le CLIENT en paramètre plutôt que d'en fabriquer un : chaque script a déjà le
 * sien, et en créer un second ouvrirait une seconde connexion vers la même base pour rien.
 */
export function makeDbExec(client: Client) {
  return (statement: InStatement, args?: InArgs): Promise<ResultSet> =>
    retry(() =>
      args === undefined
        ? client.execute(statement)
        : client.execute(statement as string, args as InArgs),
    );
}
