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

/**
 * Domaines dont un lien peut franchir la frontière vers Slack.
 *
 * Volontairement MINIMALE. Le produit ne sait livrer aucun fichier : aucun tool
 * exposé aux agents ne retourne d'URL — `generateDocument` rend l'entité
 * `Document`, qui ne déclare ni `url` ni `path` (`document/domain/entities/document.ts`),
 * et le seul chemin de fichier du dépôt (`documentPath`) appartient à un workflow
 * jamais exposé comme tool. Donc TOUT lien produit par un agent est, à ce jour,
 * fabriqué — sauf un renvoi vers Slack lui-même.
 *
 * Un sous-domaine d'une entrée est accepté (`files.slack.com` via `slack.com`) ;
 * `kissohq.slack.com` est listé explicitement pour que la liste se lise seule.
 */
export const ALLOWED_LINK_DOMAINS: readonly string[] = ['kissohq.slack.com', 'slack.com'];

/**
 * Texte substitué à un lien non autorisé.
 *
 * Il ne nomme pas le domaine retiré : l'affichage renseignerait l'utilisateur —
 * ou un attaquant — sur ce que le modèle a tenté d'émettre. Le domaine part dans
 * `strippedUrls`, donc dans les logs, jamais dans Slack.
 */
export const STRIPPED_LINK_PLACEHOLDER = '[lien retiré]';

export interface SanitizedAgentOutput {
  /** Texte réellement postable dans Slack. */
  text: string;
  /** Étiquettes des marqueurs internes trouvés — à journaliser, jamais à afficher. */
  redacted: string[];
  /**
   * NOMS D'HÔTE (pas les URL complètes) des liens retirés, dédupliqués, dans
   * l'ordre d'apparition.
   *
   * L'hôte suffit à décider (`kisso.internal` revient-il ?) et c'est le seul
   * fragment sûr à journaliser : le chemin d'un lien fabriqué embarque souvent un
   * identifiant réel — celui de l'incident du 2026-08-11 était
   * `https://kisso.internal/docs/<uuid>/download`, où l'UUID était le vrai
   * `Document.id`. Le recopier dans les logs y déverserait une donnée métier pour
   * rien.
   */
  strippedUrls: string[];
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
 * Découpage capturant les blocs ```code```, qui atterrissent donc aux index
 * IMPAIRS du tableau produit par `split` et sont réinsérés tels quels.
 *
 * Un seul quantifiant, paresseux, sur une classe totale : coût linéaire.
 */
const CODE_BLOCK_SPLIT = /(```[\s\S]*?```)/g;

/**
 * Jeton mrkdwn Slack `<…>` : lien (`<url>`, `<url|libellé>`) mais aussi mention
 * (`<@U123>`, `<#C123>`). Le contenu est analysé ENSUITE, en code.
 *
 * La forme complète du lien — `/<(https?:\/\/[^\s<>|]*)(?:\|[^<>]*)?>/` — a été
 * écartée bien qu'elle paraisse sûre : sur `<https://a|||||…x` sans `>` final,
 * le groupe optionnel rend le motif AMBIGU et le moteur revient en arrière sur
 * chaque position de départ, soit un coût quadratique sur une entrée fabriquée.
 * `security/detect-unsafe-regex` la signalait à juste titre.
 *
 * Ici la classe exclut les DEUX délimiteurs : le caractère qui l'arrête est
 * forcément `<`, `>` ou la fin. S'il n'est pas `>`, l'échec est immédiat et
 * aucun retour arrière n'est possible — il n'existe qu'une seule façon de
 * matcher. Coût linéaire, garanti par construction.
 */
const MRKDWN_TOKEN = /<[^<>]*>/g;

/** Cible d'un jeton : est-ce un lien http(s) ? Ancré, donc à coût constant. */
const HTTP_PREFIX = /^https?:\/\//i;

/** URL nue. Classe négative unique, un seul quantifiant, rien après : linéaire. */
const BARE_URL = /https?:\/\/[^\s<>|"'`]+/g;

/**
 * Ponctuation de fin de phrase collée à une URL nue — « voir https://x.tld/a. »
 * Sans ce retrait, le point final serait avalé par le placeholder.
 */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}']);

/**
 * Retire la ponctuation finale par un balayage arrière.
 *
 * Une regex `/[.,;:!?)\]}]+$/` ferait le même travail, mais `[…]+$` est
 * super-linéaire par retour arrière (signalé par `sonarjs/super-linear-regex`) :
 * sur une longue suite de ponctuation non suivie de la fin, le moteur réessaie
 * depuis chaque position. Ce balayage visite chaque caractère une fois au plus.
 */
function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(url[end - 1] as string)) end -= 1;
  return url.slice(0, end);
}

/**
 * Nom d'hôte d'une URL, en minuscules. Purement lexical (aucun `new URL()`, qui
 * lève sur une entrée malformée — or l'entrée vient d'un LLM).
 *
 * Deux pièges traités explicitement :
 *  - `userinfo@` : dans `https://kissohq.slack.com@evil.tld/x`, l'hôte réel est
 *    `evil.tld`. On retient donc ce qui suit le DERNIER `@`, jamais le début.
 *  - le port : `:443` est retiré, mais seulement s'il est numérique — sinon un
 *    IPv6 littéral (`[::1]`) serait tronqué.
 */
function hostnameOf(url: string): string {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return '';

  const afterScheme = url.slice(schemeEnd + 3);
  const pathStart = afterScheme.search(/[/?#]/);
  let authority = pathStart === -1 ? afterScheme : afterScheme.slice(0, pathStart);

  const userInfoEnd = authority.lastIndexOf('@');
  if (userInfoEnd !== -1) authority = authority.slice(userInfoEnd + 1);

  const portStart = authority.lastIndexOf(':');
  if (portStart !== -1 && /^\d*$/.test(authority.slice(portStart + 1))) {
    authority = authority.slice(0, portStart);
  }

  return authority.toLowerCase();
}

/** Hôte exact, ou sous-domaine d'une entrée de l'allowlist. */
function isAllowedHost(host: string): boolean {
  return ALLOWED_LINK_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Retire les liens dont l'hôte n'est pas dans {@link ALLOWED_LINK_DOMAINS} et
 * remonte les hôtes concernés.
 *
 * Les blocs de code sont préservés intégralement : un extrait de code peut
 * légitimement citer une URL, et il n'est pas cliquable dans Slack.
 *
 * L'ordre des deux passes compte. La forme mrkdwn est traitée EN PREMIER, sinon
 * la passe « URL nue » viderait l'intérieur de `<…|…>` et laisserait derrière
 * elle une balise orpheline `<[lien retiré]|texte>`.
 */
function stripDisallowedLinks(text: string): { text: string; hostnames: string[] } {
  const seen = new Set<string>();

  const filterSegment = (segment: string): string =>
    segment
      .replace(MRKDWN_TOKEN, (token) => {
        const inner = token.slice(1, -1);
        const pipe = inner.indexOf('|');
        const target = pipe === -1 ? inner : inner.slice(0, pipe);

        // Mentions Slack (`<@U123>`, `<#C123>`) et autres jetons non-http :
        // rien à filtrer, on les rend intacts.
        if (!HTTP_PREFIX.test(target)) return token;

        const host = hostnameOf(target);
        if (isAllowedHost(host)) return token;
        if (host) seen.add(host);
        // Le libellé part avec le lien : « clique ici » sans cible est au mieux
        // inutile, au pire trompeur sur ce que le message prétendait offrir.
        return STRIPPED_LINK_PLACEHOLDER;
      })
      .replace(BARE_URL, (match) => {
        const trimmed = trimTrailingPunctuation(match);
        const host = hostnameOf(trimmed);
        if (isAllowedHost(host)) return match;
        if (host) seen.add(host);
        return STRIPPED_LINK_PLACEHOLDER + match.slice(trimmed.length);
      });

  const filtered = text
    .split(CODE_BLOCK_SPLIT)
    .map((segment, index) => (index % 2 === 1 ? segment : filterSegment(segment)))
    .join('');

  return { text: filtered, hostnames: [...seen] };
}

/**
 * Applique les conversions en préservant intégralement les blocs de code.
 */
function toSlackMrkdwn(text: string): string {
  return text
    .split(CODE_BLOCK_SPLIT)
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

  if (!text) return { text: NEUTRAL_REFUSAL, redacted: [], strippedUrls: [] };

  const redacted = INTERNAL_MARKERS.filter((marker) => marker.pattern.test(text)).map(
    (marker) => marker.label,
  );

  if (redacted.length > 0) return { text: NEUTRAL_REFUSAL, redacted, strippedUrls: [] };

  // Un lien non autorisé ne déclenche PAS `NEUTRAL_REFUSAL`, contrairement à un
  // marqueur interne. Les deux défauts n'ont ni la même nature ni le même coût.
  //
  // Un marqueur interne est une FUITE : la réponse entière est suspecte, puisque
  // le modèle y parle de son propre garde-fou. La jeter ne perd rien d'utile.
  //
  // Un lien fabriqué est une INEXACTITUDE LOCALE dans une réponse par ailleurs
  // exploitable — celle du 2026-08-11 à 3:07 portait un vrai résumé et une seule
  // URL inventée. Tout jeter transformerait chaque hallucination de lien en
  // panne totale du tour, alors que le mal se répare en retirant le lien. Le
  // signal, lui, ne se perd pas : il part dans `strippedUrls`, donc dans les logs.
  const { text: withoutLinks, hostnames } = stripDisallowedLinks(text);

  return { text: toSlackMrkdwn(withoutLinks), redacted: [], strippedUrls: hostnames };
}
