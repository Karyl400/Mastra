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

/**
 * `action_id` du bouton, lu par la route d'interactivité.
 *
 * ⚠️ Il vit ICI, avec `buildProfileButtonBlock` qui l'émet. Les séparer ferait qu'un
 * renommage puisse casser un seul des deux côtés — et le côté cassé (la route) ne
 * signalerait rien : un `action_id` inconnu se traduit par un clic sans effet.
 */
export const COMPLETE_PROFILE_ACTION_ID = 'complete_profile';

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
          "Ravi de t'accueillir chez Kisso. Il me manque une information " +
          'pour préparer ton intégration — une minute suffit.' +
          channelsLine(joinedNames),
      },
    },
    buildProfileButtonBlock(prefill),
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
