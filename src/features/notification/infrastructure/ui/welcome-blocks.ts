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
import { type NewcomerIdentity } from '../../../onboarding/domain/services/newcomer-identity';
import { PROFILE_FORM_INVITE } from '../../../../shared/profile-request';
import { videoLine, writtenGuide } from '../../../../shared/onboarding-video';

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
 * La phrase de la vidéo DISPARAÎT quand aucune URL n'est résolvable — jamais un lien mort dans
 * le premier message de l'entreprise à quelqu'un. Depuis le 2026-08-19 la vidéo existe et son
 * URL est DÉDUITE du domaine de production (`onboarding-video.ts`) : elle n'est donc plus
 * conditionnée à une variable qu'on aurait pu oublier de poser.
 */
export function buildWelcomeBlocks(
  prefill: NewcomerIdentity,
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
  ];
}

/**
 * Le MÊME parcours, hors du flux d'arrivée.
 *
 * ## Ce qui a été corrigé le 2026-08-19
 *
 * Ce chemin — celui de quelqu'un DÉJÀ dans le workspace qui demande son formulaire — était
 * resté sur l'ancien bouton « Compléter mon profil » : pas de vidéo, pas de guide écrit, et
 * surtout aucune vérification. Deux parcours pour la même tâche, dont un cassé par la même
 * cause que l'autre (le jeton d'ouverture d'une fenêtre expire en 3 s, le démarrage à froid
 * en prend 5). C'est exactement la divergence que ce dépôt traque : deux émetteurs pour un
 * même geste, et celui qu'on exerce le moins est celui qui pourrit.
 *
 * Il reçoit donc désormais la vidéo, le guide et « C'est fait », comme l'arrivant.
 *
 * ⚠️ Seule la PHRASE D'OUVERTURE reste distincte, et c'est délibéré : « Ravi de t'accueillir
 * chez Kisso » adressé à quelqu'un qui est là depuis six mois sonne faux. Le reste est
 * partagé — le dupliquer garantirait qu'un jour les deux ne disent plus la même chose.
 */
export function buildProfileInviteBlocks(): SlackBlock[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: PROFILE_FORM_INVITE + videoLine() + writtenGuide() },
    },
  ];
}
