/**
 * Reconnaissance d'une DEMANDE DE FORMULAIRE DE PROFIL — court-circuit déterministe,
 * zéro appel LLM.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le défaut : le formulaire était INATTEIGNABLE, pour tout le monde
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `buildWelcomeBlocks` est le SEUL émetteur du bouton « Compléter mon profil », et son
 * seul appelant est `handleTeamJoin`. Un salarié déjà présent n'avait donc aucun chemin
 * vers ce formulaire — et l'événement `team_join` ne figure même pas dans les abonnements
 * de l'app Slack, si bien que les nouveaux arrivants non plus.
 *
 * Conséquence mesurée sur la Turso de production le 2026-08-14 : `employees` compte
 * 2 lignes, quand `slack_directory` porte 4 personnes vivantes de plus, toutes avec
 * `employee_id` à `null`. C'est de là que découlent le guide « générique » (aucun dossier
 * à personnaliser), l'échec de `getEmployeeProfile` sur la plupart des gens, et — de biais
 * — le document parti à la mauvaise adresse.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * L'asymétrie, INVERSE de celle de `forget.ts`
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `forget.ts` exige un ACTE DE LANGAGE strict parce qu'un faux positif détruit des données
 * que rien ne rétablit. Ici, un faux positif **poste un bouton** : geste additif, que la
 * personne ignore en continuant à écrire. Un faux négatif, lui, laisse quelqu'un sans
 * dossier — et ce dépôt vient de mesurer ce que ça coûte.
 *
 * Le critère est donc plus large sur UN point précis, et sur un seul : **les questions de
 * MOYEN déclenchent.** « comment je complète mon profil ? » n'est pas un ordre, mais le
 * bouton EST littéralement la réponse à cette question — la refuser enverrait un run LLM
 * complet, sur un budget de ≈ 19 messages par jour, pour produire une phrase moins utile.
 *
 * Restent écartées, et c'est délibéré :
 *  - les questions de MOTIF (« pourquoi dois-je… ? ») : elles appellent une explication,
 *    que le bouton ne donne pas ;
 *  - les négations (« je ne veux pas… ») ;
 *  - le profil d'un TIERS (« complète le profil de Awa ») : la modale ne sait éditer que
 *    le sien, et poster un bouton en réponse laisserait croire l'inverse — exactement le
 *    genre de malentendu que ce dépôt corrige ailleurs ;
 *  - la simple CONSULTATION (« montre-moi mon profil ») : c'est `getEmployeeProfile`, un
 *    autre geste.
 */

/**
 * Normalisation commune : minuscules, accents retirés, ponctuation réduite à l'espace.
 *
 * Identique à `forget.ts` et `greeting.ts` — liste blanche `[a-z0-9 ]` après décomposition
 * NFD, jamais une liste noire.
 */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .toLowerCase()
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Radicaux des verbes, comparés en PRÉFIXE DE MOT.
 *
 * La tokenisation par espaces rend le bord droit gratuit (`complete`, `completer`,
 * `completez` commencent tous par `complet`) et le bord gauche garanti. Une comparaison
 * par sous-chaîne ferait correspondre n'importe quel mot les contenant — l'erreur que le
 * routage a déjà payée avec `test` dans `conteste`.
 */
const EDIT_VERB_STEMS: readonly string[] = [
  'complet', // complète, compléter, complétez
  'rempli', // remplis, remplir, remplissez
  'renseign', // renseigne, renseigner
  'corrig', // corrige, corriger
  'modifi', // modifie, modifier
  'mets', // « mets à jour »
  'mettre', // « mettre à jour »
  'actualis', // actualise, actualiser
  'update',
];

/**
 * Verbes de TRANSMISSION — et ils ne valent QUE pour le formulaire lui-même.
 *
 * « renvoie-moi le formulaire de profil » est une demande légitime, mais « envoie mon
 * profil à Awa » n'en est pas une : c'est une transmission à un tiers, que la modale ne
 * fait pas. Les rattacher aux mêmes objets que les verbes d'édition transformerait cette
 * seconde demande en bouton posté — un faux positif qui AVALE une vraie question au lieu
 * de simplement s'ajouter à côté, donc le seul type de faux positif que l'asymétrie de ce
 * module ne rend PAS acceptable.
 *
 * D'où deux familles, appariées à deux jeux d'objets distincts.
 */
const SEND_VERB_STEMS: readonly string[] = [
  'renvoi', // renvoie
  'renvoy', // renvoyer
  'redonn', // redonne, redonner
  'envoi', // envoie
  'envoy', // envoyer
  'ouvr', // ouvre, ouvrir
  'donne',
];

/**
 * Objets qui désignent le dossier de LA PERSONNE QUI PARLE.
 *
 * Critère d'admission : le déterminant doit être POSSESSIF DE PREMIÈRE PERSONNE. C'est ce
 * qui écarte « le profil de Awa » — un objet à la troisième personne, que la modale ne sait
 * pas éditer.
 *
 * ⚠️ « mon compte » est VOLONTAIREMENT absent : il désigne aussi bien un compte email,
 * GitHub ou Slack, c'est-à-dire du provisioning que ce système ne fait pas. Répondre par
 * un formulaire de profil à cette demande-là serait un contresens.
 */
const PROFILE_OBJECTS: readonly string[] = [
  'mon profil',
  'mes informations',
  'mes infos',
  'ma fiche',
  'mon dossier',
  'mes coordonnees',
  'mes donnees personnelles',
  'my profile',
];

/**
 * Le formulaire lui-même — seul objet qu'un verbe de transmission peut prendre.
 *
 * Il n'y a qu'UN formulaire dans ce système, donc l'expression ne peut désigner que lui.
 */
const FORM_OBJECTS: readonly string[] = [
  'formulaire de profil',
  'formulaire du profil',
  'le formulaire',
  'profile form',
];

/**
 * Formules qui font d'un verbe une DEMANDE alors qu'il n'ouvre pas le message.
 *
 * Cherchées dans les quelques mots qui PRÉCÈDENT le verbe (voir
 * `REQUEST_LOOKBACK_WORDS`).
 *
 * ⚠️ `comment` et `ou` y figurent — c'est LA différence assumée avec `forget.ts`. Voir
 * l'en-tête : le bouton est la réponse à une question de moyen. `pourquoi` en est absent
 * pour la même raison, à l'envers : c'est une question de motif.
 */
const REQUEST_MARKERS: readonly string[] = [
  'peux tu',
  'tu peux',
  'pourrais tu',
  'tu pourrais',
  'merci de',
  'je veux',
  'je voudrais',
  'j aimerais',
  'je dois',
  'je peux',
  'comment',
  'ou est',
  'ou je',
  'please',
];

/**
 * Nombre de mots examinés avant le verbe pour y chercher une formule de demande.
 *
 * Six, contre trois dans `forget.ts` : les tournures de demande sont ici plus longues.
 * « où est-ce que je remplis mon profil » place le verbe en sixième position, et le
 * marqueur (`ou est`) tout au début.
 */
const REQUEST_LOOKBACK_WORDS = 6;

/**
 * Nombre de mots examinés DE PART ET D'AUTRE du verbe pour y chercher une négation.
 *
 * Quatre, comme dans `forget.ts`, et pour la même raison : le français sépare volontiers
 * la négation du verbe (« je ne veux pas compléter »), et une garde d'adjacence ne la
 * verrait pas.
 */
const NEGATION_WINDOW_WORDS = 4;

const NEGATIONS: ReadonlySet<string> = new Set([
  'ne',
  'n',
  'pas',
  'sans',
  'jamais',
  'aucun',
  'aucune',
  'rien',
  'inutile',
  'never',
  'dont',
]);

/**
 * Mots qui font basculer la demande vers un MOTIF plutôt qu'un moyen.
 *
 * « pourquoi dois-je compléter mon profil ? » porte le verbe, l'objet et même une formule
 * de demande (`je dois`). Seule cette garde le distingue d'une vraie demande — et la
 * distinction compte : cette personne attend une explication, pas un formulaire.
 */
const MOTIVE_MARKERS: readonly string[] = ['pourquoi', 'why'];

/**
 * Borne de longueur. Une demande de formulaire est courte. Au-delà, le message contient
 * forcément autre chose, et cet autre chose mérite une vraie réponse — même borne et même
 * raisonnement que `forget.ts`.
 */
const MAX_REQUEST_LENGTH = 200;

function isNegated(words: readonly string[], verbIndex: number): boolean {
  const from = Math.max(0, verbIndex - NEGATION_WINDOW_WORDS);
  const to = Math.min(words.length, verbIndex + NEGATION_WINDOW_WORDS + 1);

  for (let i = from; i < to; i += 1) {
    if (i !== verbIndex && NEGATIONS.has(words[i]!)) return true;
  }

  return false;
}

/**
 * Ce verbe-ci est-il employé comme une demande ?
 *
 * Deux formes : il ouvre le message (impératif), ou il est précédé d'une formule de
 * demande. Tout le reste est écarté — « mon profil est complet » porte le verbe et
 * l'objet sans rien demander.
 */
function isARequest(words: readonly string[], verbIndex: number): boolean {
  if (verbIndex === 0) return true;

  const before = words.slice(Math.max(0, verbIndex - REQUEST_LOOKBACK_WORDS), verbIndex).join(' ');
  return REQUEST_MARKERS.some((marker) => before.includes(marker));
}

function startsWithAny(word: string, stems: readonly string[]): boolean {
  return stems.some((stem) => word.startsWith(stem));
}

/**
 * Le message demande-t-il le formulaire de profil de son auteur ?
 *
 * Les termes sont évalués du moins coûteux au plus coûteux : la borne de longueur, puis
 * l'objet (une recherche de sous-chaîne écarte l'immense majorité des messages), puis le
 * motif, puis seulement l'analyse de position du verbe.
 */
export function requestsProfileForm(text: string | undefined | null): boolean {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_REQUEST_LENGTH) return false;

  const normalized = normalize(raw);

  const aboutMyProfile = PROFILE_OBJECTS.some((object) => normalized.includes(object));
  const aboutTheForm = FORM_OBJECTS.some((object) => normalized.includes(object));
  if (!aboutMyProfile && !aboutTheForm) return false;

  if (MOTIVE_MARKERS.some((marker) => normalized.includes(marker))) return false;

  const words = normalized.split(' ');

  // Chaque famille de verbes est appariée à son jeu d'objets — voir `SEND_VERB_STEMS`.
  return words.some((word, index) => {
    const isEdit = aboutMyProfile && startsWithAny(word, EDIT_VERB_STEMS);
    const isSend = aboutTheForm && startsWithAny(word, SEND_VERB_STEMS);
    if (!isEdit && !isSend) return false;

    return isARequest(words, index) && !isNegated(words, index);
  });
}

/**
 * Phrase qui accompagne le bouton hors du flux d'arrivée.
 *
 * Distincte du DM d'accueil à dessein : « Ravi de t'accueillir chez Kisso » adressé à
 * quelqu'un qui est là depuis six mois sonne faux, et ce dépôt sait déjà ce que coûte un
 * texte qui ne correspond pas à la situation de son destinataire.
 */
export const PROFILE_FORM_INVITE =
  'Voilà le formulaire. Il tient en quatre champs et alimente ton dossier — ' +
  "c'est lui qui me permet de retrouver ton profil et de préparer tes documents.";

/**
 * Réponse en CANAL — on n'y poste pas le bouton, et ce n'est pas de l'ergonomie.
 *
 * Le pré-remplissage voyage dans le `value` du bouton, figé à la publication. Dans un canal,
 * n'importe quel témoin peut cliquer : il ouvrirait une modale portant les données de
 * QUELQU'UN D'AUTRE, et sa soumission écrirait le dossier de cette personne. Le DM d'accueil
 * n'a jamais eu ce problème — il est privé par construction.
 */
export const PROFILE_FORM_CHANNEL_REDIRECT =
  "Le formulaire est personnel, je te l'envoie en message direct : écris-moi en privé " +
  '« complète mon profil » et je te l’ouvre.';
