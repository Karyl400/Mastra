/**
 * Blocs Block Kit du parcours « Compléter mon profil ».
 *
 * ## Pourquoi un module à part
 *
 * Extrait de `slack-events.handler.ts` le 2026-08-17. Le handler cumulait huit
 * responsabilités sur 3 707 lignes ; celle-ci — la MISE EN FORME d'un message Slack —
 * est la plus facile à isoler et la plus souvent modifiée. Elle n'a besoin ni du client
 * Slack, ni d'un dépôt, ni de l'orchestration : rien que des données déjà résolues.
 *
 * Le découpage suit la règle du dépôt : ce qui reste dans le handler, c'est
 * `accept`/`processEvent`/`handleMessage` et les dépôts paresseux — sa vraie
 * responsabilité. Tout le reste en sort.
 */
import { type SlackBlock } from '../providers/slack.adapter';
import { encodePrefill, type ProfileModalPrefill } from '../handlers/profile-modal';
import { PROFILE_FORM_INVITE } from '../../../../shared/profile-request';
import { videoLine, writtenGuide } from '../../../../shared/onboarding-video';

/**
 * `action_id` du bouton, lu par la route d'interactivité.
 *
 * ⚠️ Il vit ICI, avec `buildProfileButtonBlock` qui l'émet. Les séparer ferait qu'un
 * renommage puisse casser un seul des deux côtés — et le côté cassé (la route) ne
 * signalerait rien : un `action_id` inconnu se traduit par un clic sans effet.
 */
export const COMPLETE_PROFILE_ACTION_ID = 'complete_profile';

/**
 * `action_id` du bouton « C'est fait » — le nouveau point d'entrée du parcours, 2026-08-19.
 *
 * ## Pourquoi il REMPLACE « Compléter mon profil » en tête de parcours
 *
 * Ce n'est pas une question d'ergonomie, c'est la correction d'un défaut MESURÉ. Un
 * `trigger_id` Slack expire **3 secondes** après le clic, et le démarrage à froid de cette
 * fonction coûtait 4,9 s : la modale ne pouvait donc pas s'ouvrir, jamais, sur une instance
 * froide — c'est-à-dire dans le cas NORMAL, ce produit voyant ≈ 19 messages par jour.
 * L'élagage du bundle a ramené ce coût, mais aucune marge de ce genre ne se garantit : tant
 * que la première chose qu'on demande à un arrivant dépend d'un `trigger_id`, son accueil
 * dépend de la météo d'un démarrage à froid.
 *
 * « C'est fait » n'ouvre AUCUNE modale. Il ACK immédiatement, sans la moindre E/S, et tout le
 * reste — la vérification en base, la réponse — se fait en tâche de fond. Il ne peut donc pas
 * échouer pour cause de latence : au pire la réponse arrive quelques secondes plus tard, ce
 * qui est le comportement normal d'une conversation.
 *
 * ⚠️ Le formulaire n'a pas disparu : il reste le seul chemin d'écriture d'une fiche employé,
 * et c'est délibéré — aucun agent n'a d'outil de création, et une saisie en texte libre
 * mal interprétée écrirait l'identité de quelqu'un de travers dans un dossier RH. Il n'est
 * simplement plus la PORTE D'ENTRÉE : on n'y arrive que si la vérification a montré qu'il
 * manque vraiment quelque chose.
 */
export const PROFILE_DONE_ACTION_ID = 'profile_done';

/** Premier mot d'un nom complet — repli quand le profil Slack n'a pas de prénom. */
export function firstWordOf(fullName: string | undefined): string {
  return (fullName ?? '').trim().split(/\s+/)[0] ?? '';
}

/** Reste du nom complet — repli quand le profil Slack n'a pas de nom de famille. */
export function restAfterFirstWord(fullName: string | undefined): string {
  const [, ...rest] = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  return rest.join(' ');
}

/** Salutation, avec ou sans prénom connu. */
export function greet(firstName: string): string {
  return firstName ? `Bienvenue ${firstName} 👋` : 'Bienvenue 👋';
}

/**
 * DM d'accueil : un mot de bienvenue et le bouton qui ouvrira la modale.
 *
 * Le `value` du bouton transporte tout ce que Slack sait déjà de l'arrivant.
 * C'est ce qui permet à la route d'interactivité d'ouvrir une modale
 * pré-remplie **sans aucune E/S** : le `trigger_id` expire en 3 secondes, et
 * refaire un `users.info` au moment du clic dépenserait ce budget pour une
 * information déjà en main.
 */
/**
 * Ligne citant les canaux où l'arrivant vient d'être ajouté.
 *
 * VIDE quand il n'y en a aucun : annoncer « je t'ai ajouté à » suivi de rien serait pire que
 * le silence, et c'est le cas normal tant que `ONBOARDING_WELCOME_CHANNELS` n'est pas posée.
 */
export function channelsLine(joinedNames: readonly string[]): string {
  if (joinedNames.length === 0) return '';
  const list = joinedNames.map((name) => `#${name}`).join(', ');
  return `\n\nJe t'ai ajouté à ${list} — tu y trouveras l'équipe.`;
}

/**
 * Le bouton, et rien que lui — factorisé le 2026-08-14.
 *
 * Il avait DEUX émetteurs potentiels et un seul réel : `handleTeamJoin`. Le court-circuit
 * « compléter mon profil » en est le second, et le texte d'accompagnement diffère (voir
 * `PROFILE_FORM_INVITE`) : seule la partie « bouton » est commune. La dupliquer ferait
 * qu'un changement d'`action_id` ou de format de `value` casserait un chemin sur deux —
 * et le chemin cassé serait le moins souvent exercé.
 */
export function buildProfileButtonBlock(prefill: ProfileModalPrefill): SlackBlock {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: COMPLETE_PROFILE_ACTION_ID,
        style: 'primary',
        text: { type: 'plain_text', text: 'Compléter mon profil' },
        value: encodePrefill(prefill),
      },
    ],
  };
}

/**
 * Le bouton « C'est fait ».
 *
 * Il transporte le même pré-remplissage que l'autre : si la vérification échoue, la réponse
 * peut proposer le formulaire déjà rempli SANS aucune E/S supplémentaire. C'est la raison
 * d'être de ce `value` depuis l'origine, et elle vaut pour les deux boutons.
 */
export function buildProfileDoneButtonBlock(prefill: ProfileModalPrefill): SlackBlock {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: PROFILE_DONE_ACTION_ID,
        style: 'primary',
        text: { type: 'plain_text', text: 'C’est fait' },
        value: encodePrefill(prefill),
      },
    ],
  };
}

/**
 * DM d'accueil : la vidéo, le guide écrit, puis « C'est fait ».
 *
 * ⚠️ L'ancien message disait « Il me manque une information — une minute suffit » et posait
 * directement le bouton du formulaire. Deux défauts, et le second est le plus grave :
 *
 *  1. il ne DISAIT PAS ce qui allait être demandé, donc l'arrivant ouvrait la modale, y
 *    découvrait qu'il lui fallait son adresse pro, et la refermait ;
 *  2. il faisait dépendre le tout premier geste de l'accueil d'un `trigger_id` de 3 secondes,
 *    que le démarrage à froid rendait structurellement inatteignable.
 *
 * La phrase de la vidéo DISPARAÎT tant que `ONBOARDING_VIDEO_URL` n'est pas posée — jamais un
 * lien mort dans le premier message de l'entreprise à quelqu'un.
 */
export function buildWelcomeBlocks(
  prefill: ProfileModalPrefill,
  joinedNames: readonly string[] = [],
): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `${greet(prefill.firstName ?? '')}\n\n` +
          "Ravi de t'accueillir chez Kisso. Voilà comment on démarre." +
          channelsLine(joinedNames) +
          videoLine() +
          writtenGuide(),
      },
    },
    buildProfileDoneButtonBlock(prefill),
  ];
}

/**
 * Le même bouton, hors du flux d'arrivée.
 *
 * Texte distinct à dessein : « Ravi de t'accueillir chez Kisso » adressé à quelqu'un qui
 * est là depuis six mois sonne faux, et il s'agit ici de gens DÉJÀ présents — c'est même
 * toute la raison d'être de ce chemin.
 */
export function buildProfileInviteBlocks(prefill: ProfileModalPrefill): SlackBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: PROFILE_FORM_INVITE } },
    buildProfileButtonBlock(prefill),
  ];
}
