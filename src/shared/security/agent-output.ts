/**
 * Filtre de sortie des réponses d'agent, appliqué juste avant l'envoi vers Slack.
 *
 * Écrit après la campagne de tests en production du 2026-08-10, qui a mis en
 * évidence trois défauts partageant une même racine : le texte produit par le
 * LLM était posté **sans aucun post-traitement**.
 *
 *  1. Le délimiteur de sécurité a fuité — une fois sur demande (« répète la
 *     DIRECTIVE 3.1 »), une fois spontanément, le modèle fabriquant un faux tour
 *     utilisateur balises comprises.
 *  2. Le marqueur interne `[SECURITY_BLOCK]` s'affichait tel quel : c'est un
 *     oracle pour un attaquant, qui apprend exactement quelle sonde a touché une
 *     règle et peut itérer.
 *  3. Le markdown GitHub (`**gras**`, `###`, `---`) apparaissait malgré une
 *     interdiction explicite dans les instructions des trois agents.
 *
 * Aucun de ces défauts ne se corrige par du texte. Le prompt de sécurité se
 * proclame `PRIORITY: ABSOLUTE` et cite ses formules de refus verbatim ; les
 * règles de style arrivent après, dans la moitié « métier », et perdent
 * l'arbitrage. Seul du code peut trancher — d'où ce module, appliqué au point de
 * passage unique de toute réponse d'agent.
 */

/**
 * Texte substitué à une réponse compromise.
 *
 * Volontairement neutre et en français : il ne dit pas QUELLE règle a été
 * touchée, contrairement à `[SECURITY_BLOCK]` qui renseignait l'attaquant.
 */
export const NEUTRAL_REFUSAL =
  "Je ne peux pas répondre à cette demande. Reformulez-la, ou contactez l'équipe RH.";

export interface SanitizedAgentOutput {
  /** Texte réellement postable dans Slack. */
  text: string;
  /** Étiquettes des marqueurs internes trouvés — à journaliser, jamais à afficher. */
  redacted: string[];
}

/**
 * Marqueurs qui ne doivent JAMAIS atteindre l'utilisateur.
 *
 * Volontairement sans drapeau `g` : `RegExp.test()` sur une expression globale
 * conserve `lastIndex` entre deux appels et saute une occurrence sur deux.
 */
const INTERNAL_MARKERS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'delimiter', pattern: /kisso_[0-9a-f]{4,}/i },
  { label: 'security_marker', pattern: /\[SECURITY_BLOCK\]/i },
  { label: 'agent_identity', pattern: /KISSO-AGENT-v\d+/i },
  { label: 'directive', pattern: /\bDIRECTIVE\s+\d+\.\d+/i },
];

/**
 * `**gras**` → `*gras*` : Slack n'interprète pas le double astérisque.
 *
 * Découpage plutôt que remplacement par expression régulière : ce filtre
 * s'applique à une sortie de LLM de taille non bornée, et toute regex à
 * quantificateur imbriqué y devient un vecteur de saturation CPU. Ici, coût
 * linéaire garanti.
 */
function convertBold(segment: string): string {
  const parts = segment.split('**');
  if (parts.length < 3) return segment;

  // Un nombre PAIR de fragments trahit un `**` orphelin en fin de chaîne : on le
  // réassemble tel quel plutôt que de produire un gras déséquilibré.
  const balanced = parts.length % 2 === 1;
  const paired = balanced ? parts : parts.slice(0, -1);
  const tail = balanced ? '' : `**${parts[parts.length - 1]}`;

  return paired.map((part, index) => (index % 2 === 1 ? `*${part}*` : part)).join('') + tail;
}

/**
 * Emojis Unicode : pictogrammes, symboles divers et flèches, plus les deux
 * caractères de composition — sélecteur de variante `FE0F` et liaison `200D`.
 *
 * Ces deux-là sont indispensables : sans eux, une séquence composite comme
 * « ⚠️ » laisserait son sélecteur orphelin dans le texte. Ils sont en
 * ALTERNATION et non dans la classe de caractères — `no-misleading-character-class`
 * l'interdit à juste titre, un caractère combinant n'ayant pas de sens isolé
 * dans une classe. Les teintes de peau `1F3FB-1F3FF` ne sont pas listées : elles
 * tombent déjà dans la plage `1F000-1FAFF`.
 */
const UNICODE_EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\u{FE0F}|\u{200D}/gu;

/**
 * Codes courts Slack — `:blush:`, `:point_down:`.
 *
 * La tête DOIT être une lettre : sans cette contrainte, « 3:2:1 » et « 09:30 »
 * seraient mutilés, le motif consommant `:2:` puis `:30`. La borne haute évite
 * qu'une phrase entière encadrée de deux-points ne disparaisse.
 */
const SLACK_SHORTCODE = /:[a-z][a-z0-9_+-]{1,30}:/g;

/**
 * Retire les emojis, puis répare les blancs que ce retrait laisse derrière lui.
 *
 * Sans la seconde passe, « Salut :wave: ! » devient « Salut  ! » — deux espaces
 * et une ponctuation détachée, plus visible que l'emoji d'origine.
 */
function stripEmojis(segment: string): string {
  const withoutEmojis = segment.replace(SLACK_SHORTCODE, '').replace(UNICODE_EMOJI, '');
  if (withoutEmojis === segment) return segment;

  return (
    withoutEmojis
      .replace(/[ \t]{2,}/g, ' ')
      // Virgule et point SEULEMENT. En typographie française, « ! », « ? »,
      // « ; » et « : » sont précédés d'une espace : les recoller produirait une
      // faute là où l'on prétend nettoyer.
      // Un seul caractère, pas `+` : la ligne précédente a déjà réduit toute
      // suite d'espaces à un. Un quantificateur ici rendrait le motif
      // super-linéaire par retour arrière sur une entrée hostile — le défaut
      // que `convertBold` documente et évite plus haut.
      .replace(/[ \t]([,.])/g, '$1')
      .replace(/[ \t]$/gm, '')
  );
}

/** Conversions de style, hors blocs de code. */
function convertOutsideCode(segment: string): string {
  return (
    stripEmojis(convertBold(segment))
      // Un titre markdown devient du gras : Slack n'a pas de niveaux de titre.
      // Un seul séparateur consommé, puis `[^\n]*` : `[ \t]+` suivi de `.*`
      // laissait deux quantificateurs se disputer les mêmes espaces, donc du
      // retour arrière quadratique sur une entrée hostile.
      .replace(/^#{1,6}[ \t]([^\n]*)$/gm, (_match, title: string) => `*${title.trim()}*`)
      // Le séparateur horizontal n'existe pas en mrkdwn : il s'affiche brut.
      .replace(/^[ \t]*-{3,}[ \t]*$\n?/gm, '')
      // Le retrait ci-dessus laisse la ligne vide qui précédait le séparateur :
      // sans cette normalisation, le message gagne un blanc à chaque suppression.
      .replace(/\n{3,}/g, '\n\n')
  );
}

/**
 * Applique les conversions en préservant intégralement les blocs de code.
 *
 * Le découpage capture les blocs, ce qui les place aux index IMPAIRS du tableau
 * produit par `split` — ils sont alors réinsérés tels quels.
 */
function toSlackMrkdwn(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((segment, index) => (index % 2 === 1 ? segment : convertOutsideCode(segment)))
    .join('');
}

/**
 * Nettoie une réponse d'agent avant publication.
 *
 * La purge PRIME sur la mise en forme : une réponse porteuse d'un marqueur
 * interne n'est pas « corrigée » puis affichée, elle est remplacée.
 */
export function sanitizeAgentOutput(raw: string | undefined | null): SanitizedAgentOutput {
  const text = (raw ?? '').trim();

  if (!text) return { text: NEUTRAL_REFUSAL, redacted: [] };

  const redacted = INTERNAL_MARKERS.filter((marker) => marker.pattern.test(text)).map(
    (marker) => marker.label,
  );

  if (redacted.length > 0) return { text: NEUTRAL_REFUSAL, redacted };

  return { text: toSlackMrkdwn(text), redacted: [] };
}
