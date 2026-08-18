import type { ConversationExcerpt } from '../entities/conversation-excerpt';
import { selectSalientExcerpts } from './excerpt-salience';

/**
 * LA BORNE DE COÛT — le point unique par lequel passe tout ce que cette feature
 * montre au modèle.
 *
 * ── La contrainte, telle qu'elle est réellement ─────────────────────────────
 * Le plafond qui casse la production n'est pas le seau Groq par minute mais le
 * quota JOURNALIER : `TPD: Limit 100000, Used 98207` dans les en-têtes de
 * l'incident du 2026-08-11, soit ≈ 19 messages par jour tous canaux confondus.
 * Et un tool-result n'est pas payé une fois : il entre dans l'historique et est
 * réémis à CHAQUE aller-retour suivant.
 *
 * Une récupération de conversations est, par nature, le pire candidat du dépôt à
 * ce défaut : sa taille naturelle est proportionnelle au trafic du canal. C'est
 * exactement la forme de `getNotificationHistory` avant correction — 18 colonnes
 * brutes, `body` non borné, ≈ 9 600 tokens pour un seul appel, 10 % de la
 * journée entière brûlés d'un coup.
 *
 * ── La propriété visée, qui n'est PAS un chiffre ────────────────────────────
 * La taille de la sortie ne dépend ni du nombre de messages récupérés, ni de
 * leur longueur. 10 messages et 500 messages produisent le MÊME nombre de
 * caractères (verrouillé par test). C'est cette indépendance qui compte : un
 * chiffre se dégrade au premier canal bavard, une propriété non.
 *
 * ── Pourquoi une CHAÎNE et non un tableau d'objets ──────────────────────────
 * Six objets JSON `{"speaker":…,"text":…,"at":…}` repaient six fois le nom de
 * chaque clé, soit ≈ 30 caractères par extrait pour zéro information. Une ligne
 * `[2026-08-11 14:02] Karyl: texte` porte la même chose. Et surtout : la sortie
 * doit être encadrée par `wrapExternalData` d'un seul bloc — six blocs, ce sont
 * six bannières « UNTRUSTED EXTERNAL DATA » facturées.
 *
 * ── Nettoyage ───────────────────────────────────────────────────────────────
 * Les chevrons sont RETIRÉS ici, avant l'encadrement. `sanitizeInputAdvanced`
 * les échapperait en `&lt;` / `&gt;` — correct, mais ×4 en caractères sur un
 * texte truffé de chevrons, donc un levier d'inflation offert à l'attaquant.
 * Les retirer en amont est aussi sûr et de taille constante.
 *
 * ⚠️ TypeScript pur — seul un import de TYPE, effacé à la compilation.
 */

/**
 * Nombre maximal d'extraits rendus.
 *
 * Six, et non « autant que possible » : la question réelle est « qu'est-ce qui
 * s'est dit récemment ? », à laquelle six échanges répondent. Le budget dur du
 * lot 4 de `PLAN-ARCHITECTURE.md` est « ≤ 5 extraits / ~600 tokens » ; on tient
 * les 600 tokens avec six extraits parce que chacun est lui-même borné.
 */
export const MAX_EXCERPTS = 6;

/** Au-delà, un message n'apporte plus de contexte et coûte à chaque tour. */
export const EXCERPT_MAX_CHARS = 180;

/** Un nom d'affichage plus long qu'un tweet n'est pas un nom : c'est une charge utile. */
export const SPEAKER_MAX_CHARS = 24;

/** Marqueur de troncature : un caractère, pour ne pas repayer « [tronqué] » six fois. */
const ELLIPSIS = '…';

/**
 * Réduit un texte libre à une ligne inoffensive et bornée.
 *
 * L'ordre importe : on retire d'abord ce qui pourrait forger une frontière
 * (chevrons, retours à la ligne, caractères de contrôle), on compacte ensuite,
 * on tronque en dernier. Tronquer avant de compacter rendrait la longueur finale
 * dépendante des espaces d'origine — donc non déterministe pour un test.
 */
function flatten(value: string, maxChars: number): string {
  const withoutControls = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[<>]/g, '');

  const compacted = withoutControls.replace(/\s+/g, ' ').trim();

  return compacted.length > maxChars ? `${compacted.slice(0, maxChars)}${ELLIPSIS}` : compacted;
}

/**
 * `2026-08-11 14:02` — 16 caractères, UTC.
 *
 * Pas d'ISO complet (24 caractères, dont des millisecondes que personne ne lit),
 * pas de fuseau local : un formatage dépendant de l'environnement rendrait les
 * tests non reproductibles et ferait varier la taille de la sortie.
 */
function formatStamp(at: Date): string {
  const iso = new Date(at.getTime()).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

// ⚠️ `selectExcerpts` (tri par DATE seule) a été SUPPRIMÉ le 2026-08-14, remplacé par
// `selectSalientExcerpts`. Le garder aurait laissé DEUX sélecteurs concurrents dans le même
// module, dont un seul est appelé — la configuration qui finit par voir un nouvel appelant
// choisir le mauvais. Ses deux acquis sont conservés dans le remplaçant : rendu en ordre
// CHRONOLOGIQUE (une conversation à l'envers est illisible) et tri TOTAL (deux appels
// identiques doivent rendre la même sélection).

/**
 * Rend les extraits en lignes bornées, prêtes à être encadrées.
 *
 * ⚠️ Cette fonction ne pose PAS la frontière de données non fiables — c'est
 * `application/services/untrusted-excerpt.service.ts` qui le fait, parce que
 * l'encadrement dépend de `shared/security/llm-guardrail`, que la couche
 * `domain` n'a pas le droit d'importer. La séparation est structurelle, pas
 * esthétique.
 */
export function renderExcerptLines(excerpts: readonly ConversationExcerpt[]): string {
  return excerpts
    .map((excerpt) => {
      const speaker = flatten(excerpt.speaker, SPEAKER_MAX_CHARS) || '?';
      const text = flatten(excerpt.text, EXCERPT_MAX_CHARS);
      return `[${formatStamp(excerpt.at)}] ${speaker}: ${text}`;
    })
    .join('\n');
}

/**
 * Le chemin complet, en une fonction : trier, borner, projeter.
 *
 * Les deux tools passent par ici. Deux appels séparés à `selectExcerpts` puis
 * `renderExcerptLines` marcheraient tout aussi bien — mais un troisième appelant
 * qui oublierait le premier obtiendrait une sortie non bornée, sans qu'aucun
 * type ne s'en aperçoive.
 */
export function projectExcerpts(all: readonly ConversationExcerpt[]): {
  lines: string;
  shown: number;
  coverage?: string;
} {
  const selected = selectSalientExcerpts(all, MAX_EXCERPTS);
  return {
    lines: renderExcerptLines(selected),
    shown: selected.length,
    coverage: describeCoverage(all, selected.length),
  };
}

/**
 * LA COUVERTURE — ce que le modèle ne voit PAS, dit explicitement.
 *
 * ⚠️ Ferme une dette recensée dans `TODO.md` [0 ter] : *« une demande de résumé de conversation
 * ne porte que sur les ~1600 tokens de la fenêtre, sans avertir que le reste est tronqué »*.
 *
 * Sans cette phrase, un modèle à qui l'on montre 6 messages sur 40 répond « voici ce qui s'est
 * dit », pas « voici les 6 échanges les plus porteurs ». La différence n'est pas cosmétique :
 * la première formulation affirme une EXHAUSTIVITÉ que rien ne garantit, et c'est la famille
 * de mensonge que ce dépôt traque partout ailleurs.
 *
 * Elle nomme aussi le CRITÈRE de sélection. Depuis le 2026-08-14 les extraits ne sont plus les
 * plus récents mais les plus significatifs : un modèle qui l'ignore conclurait à tort que
 * l'échange s'arrête au dernier extrait montré.
 *
 * ⚠️ Rendue `undefined` quand tout a été montré — il n'y a alors rien à avertir, et un `hint`
 * inutile se paie à chaque aller-retour suivant (même arbitrage que le `hint` de
 * `generateDocument`, payé uniquement dans les cas dégradés).
 */
export function describeCoverage(
  all: readonly ConversationExcerpt[],
  shown: number,
): string | undefined {
  if (all.length === 0 || shown >= all.length) return undefined;

  const stamps = all.map((excerpt) => excerpt.at.getTime()).sort((a, b) => a - b);
  const from = new Date(stamps[0]!).toISOString().slice(0, 10);
  const to = new Date(stamps[stamps.length - 1]!).toISOString().slice(0, 10);
  const span = from === to ? `le ${from}` : `du ${from} au ${to}`;

  return `${shown} extraits retenus sur ${all.length} messages, ${span} — les plus porteurs d'information, PAS les plus récents. Ne conclus pas que rien d'autre n'a été dit.`;
}

/**
 * La MÊME couverture, dite à un HUMAIN.
 *
 * ⚠️ Deux fonctions et non un paramètre de forme, parce que les deux textes n'ont ni le même
 * destinataire ni le même mode. `describeCoverage` ORDONNE (« Ne conclus pas que rien d'autre
 * n'a été dit ») : c'est une consigne, elle s'adresse au modèle et n'a rien à faire dans
 * Slack, où elle donnerait à lire une instruction interne. Celle-ci CONSTATE.
 *
 * Elle est rendue `undefined` dans les mêmes conditions, et pour la même raison : un
 * avertissement posé même quand tout a été montré deviendrait du bruit, et le bruit s'ignore.
 *
 * ⚠️ mrkdwn Slack (`_italique_`), jamais markdown GitHub : ce texte est accolé par le handler
 * et ne passe par AUCUN filtre — `sanitizeAgentOutput` n'a qu'un seul site d'appel,
 * `response.text`. Un `**gras**` s'afficherait littéralement, constaté le 2026-08-18.
 */
export function describeCoverageForHuman(
  all: readonly ConversationExcerpt[],
  shown: number,
): string | undefined {
  if (all.length === 0 || shown >= all.length) return undefined;

  const stamps = all.map((excerpt) => excerpt.at.getTime()).sort((a, b) => a - b);
  const from = new Date(stamps[0]!).toISOString().slice(0, 10);
  const to = new Date(stamps[stamps.length - 1]!).toISOString().slice(0, 10);
  const span = from === to ? `le ${from}` : `du ${from} au ${to}`;

  return `_Je n'ai lu que ${shown} messages sur ${all.length}, ${span} — les plus porteurs d'information, pas les plus récents. D'autres choses ont pu être dites._`;
}
