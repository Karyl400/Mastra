import { z } from 'zod';
import { sanitizeText } from '../../../../shared/validation';
import type { SlackBlock, SlackModalView } from '../providers/slack.adapter';
import type { SlackViewState } from './profile-modal';

/**
 * Modale d'ENTRETIEN — la seconde étape du parcours, après « Compléter mon profil ».
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Ce qu'elle remplace, et pourquoi elle aboutit là où l'autre échouait
 * ════════════════════════════════════════════════════════════════════════════
 *
 * La feature `questionnaire` produisait des quiz par LLM. Relevé sur la Turso le
 * 2026-08-14 : **5 questionnaires enregistrés, 0 réponse**. Il n'existait ni formulaire, ni
 * modale, ni route de soumission — rien qu'un humain puisse remplir. Le tool le disait
 * lui-même dans son `hint`, ce qui prouve qu'on le savait sans le corriger.
 *
 * L'entretien inverse la construction : **le formulaire existe d'abord**, écrit en code, et
 * ce qui est stocké est ce qu'une personne a réellement répondu. Zéro token, zéro modèle sur
 * le chemin — même arbitrage que la modale de profil, dont c'est la raison d'être depuis que
 * `createEmployee` a été retiré des agents (le modèle substituait une valeur d'allowlist
 * valide AVANT l'appel, pour que l'appel réussisse).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Trois champs, et pas quatre
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Chaque champ de plus est un abandon de plus. La modale de profil en a quatre et ne
 * demande QUE ce que le serveur ignore.
 *
 * ⚠️ Un quatrième champ « rythme de notification » a été explicitement ÉCARTÉ : aucun
 * automate ne tourne dans ce dépôt (ni cron, ni poller, `findPending()` n'a aucun site
 * d'appel). Le proposer aurait ajouté une promesse non tenue à un produit qui vient d'en
 * retirer trois.
 */

/** Doit correspondre au `callback_id` lu par la route sur `view_submission`. */
export const INTERVIEW_MODAL_CALLBACK_ID = 'onboarding_interview';

/** `action_id` du bouton qui ouvre cette modale, posé en DM après la création du dossier. */
export const START_INTERVIEW_ACTION_ID = 'start_interview';

/**
 * Correspondance champ ↔ (`block_id`, `action_id`), source unique de vérité.
 *
 * Les `block_id` sont posés EXPLICITEMENT. À défaut, Slack en génère un aléatoire à
 * l'ouverture de la vue, et il devient impossible de rattacher une erreur de validation à un
 * champ : la clé serait inconnue, donc **ignorée en silence**, la modale se fermerait et
 * l'erreur disparaîtrait.
 */
export const INTERVIEW_FIELDS = {
  channels: { blockId: 'interview_channels', actionId: 'channels' },
  dailyWork: { blockId: 'interview_daily_work', actionId: 'daily_work' },
  workStyle: { blockId: 'interview_work_style', actionId: 'work_style' },
} as const;

/** Un canal proposable : ce que Slack en dit, réduit à ce que la modale affiche. */
export interface InterviewChannelOption {
  readonly channelId: string;
  readonly name: string;
}

export interface InterviewPrefill {
  readonly employeeId: string;
  readonly slackUserId: string;
  /** Canaux proposés, transportés dans le bouton — voir `encodeInterviewPrefill`. */
  readonly channels: readonly InterviewChannelOption[];
}

/* -------------------------------------------------------------------------- *
 * Transport dans le bouton du DM
 * -------------------------------------------------------------------------- */

/**
 * Nombre maximal de canaux proposés.
 *
 * Slack plafonne le `value` d'un bouton à **2000 caractères** et refuse la vue au-delà. Un
 * canal pèse ici ~30 caractères encodés ; douze laissent une marge confortable et dépassent
 * déjà largement le réel — le workspace en compte **6 vivants** au 2026-08-14, dont un privé.
 *
 * ⚠️ La troncature est SILENCIEUSE côté Slack si on la laisse advenir : le bouton est
 * simplement rejeté. On borne donc nous-mêmes, et l'appelant journalise ce qu'il a écarté.
 */
export const MAX_INTERVIEW_CHANNELS = 12;

/**
 * Le `value` du bouton transporte l'employé ET la liste des canaux proposés.
 *
 * C'est ce qui permet d'ouvrir la modale **sans aucune E/S** : le `trigger_id` expire en
 * 3 secondes, et lire `slack_channels` au moment du clic dépenserait ce budget pour une
 * information déjà connue au moment où le bouton a été posté. Exactement le raisonnement de
 * `encodePrefill` pour la modale de profil.
 *
 * Clés d'une lettre pour la même raison que le plafond ci-dessus : le budget est en
 * caractères, pas en lisibilité.
 */
export function encodeInterviewPrefill(prefill: InterviewPrefill): string {
  return JSON.stringify({
    e: prefill.employeeId,
    u: prefill.slackUserId,
    c: prefill.channels
      .slice(0, MAX_INTERVIEW_CHANNELS)
      .map((channel) => [channel.channelId, channel.name]),
  });
}

/**
 * Relit le `value` du bouton ou le `private_metadata` de la vue.
 *
 * Il revient dans un payload SIGNÉ, donc digne de confiance après vérification HMAC — mais
 * un ancien message peut porter un format antérieur, d'où le repli sur une charge vide plutôt
 * qu'une exception. Un bouton d'hier ne doit pas faire échouer une soumission d'aujourd'hui.
 */
export function decodeInterviewPrefill(
  value: string | undefined,
  fallbackUserId = '',
): InterviewPrefill {
  const empty: InterviewPrefill = { employeeId: '', slackUserId: fallbackUserId, channels: [] };
  if (!value) return empty;

  try {
    const parsed = JSON.parse(value) as { e?: string; u?: string; c?: unknown };
    const channels = Array.isArray(parsed.c)
      ? parsed.c
          .filter(
            (entry): entry is [string, string] =>
              Array.isArray(entry) &&
              typeof entry[0] === 'string' &&
              typeof entry[1] === 'string' &&
              isChannelId(entry[0]),
          )
          .map(([channelId, name]) => ({ channelId, name }))
      : [];

    return {
      employeeId: parsed.e ?? '',
      slackUserId: parsed.u || fallbackUserId,
      channels,
    };
  } catch {
    return empty;
  }
}

/**
 * Un identifiant de canal Slack, et rien d'autre.
 *
 * Validé des DEUX côtés (ici et dans le dépôt) parce que cette valeur finit dans
 * `conversations.invite` : la vérification HMAC prouve que Slack a signé le payload, pas que
 * son contenu désigne un canal.
 */
function isChannelId(value: string): boolean {
  return /^[CG][A-Z0-9]{2,}$/.test(value);
}

/* -------------------------------------------------------------------------- *
 * Construction de la vue
 * -------------------------------------------------------------------------- */

function longTextInput(
  field: { blockId: string; actionId: string },
  label: string,
  placeholder: string,
): SlackBlock {
  return {
    type: 'input',
    block_id: field.blockId,
    // OPTIONNEL, et c'est délibéré : le seul champ qui produit un EFFET est la liste des
    // canaux. Rendre la prose obligatoire ferait abandonner la modale à qui n'a pas envie
    // d'écrire, et lui coûterait ses canaux — le contraire du but.
    optional: true,
    label: { type: 'plain_text', text: label },
    element: {
      type: 'plain_text_input',
      action_id: field.actionId,
      multiline: true,
      max_length: MAX_FREE_TEXT_CHARS,
      placeholder: { type: 'plain_text', text: placeholder },
    },
  } as SlackBlock;
}

/**
 * Longueur maximale d'une réponse libre.
 *
 * Bornée dans la VUE (Slack refuse la saisie au-delà) *et* dans le schéma : la vue protège
 * l'humain, le schéma protège la base contre un payload forgé. Le chiffre vient de l'usage
 * aval — ce texte est imprimé dans un document et lu par un modèle ; au-delà, ce n'est plus
 * une réponse, c'est une pièce jointe.
 */
export const MAX_FREE_TEXT_CHARS = 500;

/**
 * Vue de la modale.
 *
 * `title` est plafonné à 24 caractères par Slack, et la vue est rejetée au-delà. `submit` est
 * obligatoire dès qu'un bloc `input` est présent.
 *
 * ⚠️ Le bloc `channels` n'est présent que si des canaux sont proposés. Un `multi_static_select`
 * avec `options: []` fait **rejeter la vue entière** par Slack (`invalid_arguments`) : la
 * modale ne s'ouvrirait pas du tout, et le symptôme — un clic sans effet — ne désignerait pas
 * sa cause. Le cas se produit réellement quand `slack_channels` n'a jamais été synchronisée.
 */
export function buildInterviewModal(prefill: InterviewPrefill): SlackModalView {
  const options = prefill.channels.slice(0, MAX_INTERVIEW_CHANNELS).map((channel) => ({
    // Slack plafonne un libellé d'option à 75 caractères.
    text: { type: 'plain_text', text: `#${channel.name}`.slice(0, 75) },
    value: channel.channelId,
  }));

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'Trois questions pour que je sache de quoi te tenir au courant. ' +
          'Tu peux revenir les changer quand tu veux.',
      },
    } as SlackBlock,
  ];

  if (options.length > 0) {
    blocks.push({
      type: 'input',
      block_id: INTERVIEW_FIELDS.channels.blockId,
      optional: true,
      label: { type: 'plain_text', text: 'Les canaux qui t’intéressent' },
      // Le seul champ à EFFET : à la soumission, ces canaux donnent lieu à une invitation
      // réelle. Rien n'est « proposé » à un modèle — la liste est fermée et vient de Slack.
      element: {
        type: 'multi_static_select',
        action_id: INTERVIEW_FIELDS.channels.actionId,
        placeholder: { type: 'plain_text', text: 'Choisis-en autant que tu veux' },
        options,
      },
    } as SlackBlock);
  }

  blocks.push(
    longTextInput(
      INTERVIEW_FIELDS.dailyWork,
      'Ce que tu fais au quotidien',
      'Ex. je développe les API paiement et je relis les PR de l’équipe',
    ),
    longTextInput(
      INTERVIEW_FIELDS.workStyle,
      'Comment tu préfères travailler',
      'Ex. je préfère l’écrit à l’oral, et les points courts le matin',
    ),
  );

  return {
    type: 'modal',
    callback_id: INTERVIEW_MODAL_CALLBACK_ID,
    title: { type: 'plain_text', text: 'Parlons de toi' },
    submit: { type: 'plain_text', text: 'Enregistrer' },
    close: { type: 'plain_text', text: 'Plus tard' },
    // Revient dans un payload SIGNÉ. ⚠️ MÊME encodage que le `value` du bouton, relu par la
    // même fonction des deux côtés : deux formes proches mais distinctes auraient divergé au
    // premier champ ajouté, et l'écart ne se serait vu qu'en production, à la soumission.
    private_metadata: encodeInterviewPrefill(prefill),
    blocks,
  } as SlackModalView;
}

/* -------------------------------------------------------------------------- *
 * Relecture de la soumission
 * -------------------------------------------------------------------------- */

export interface InterviewSubmission {
  channels: string[];
  dailyWork: string;
  workStyle: string;
}

interface MultiSelectStateValue {
  value?: string | null;
  selected_options?: ReadonlyArray<{ value?: string | null }> | null;
}

/**
 * Relit `view.state.values`.
 *
 * ⚠️ `multi_static_select` rend `selected_options` (PLURIEL), là où `static_select` rend
 * `selected_option`. `readProfileSubmission` ne lit que le singulier — les deux lecteurs sont
 * donc distincts, et les fondre ferait rendre une liste vide en silence.
 */
export function readInterviewSubmission(state: SlackViewState): InterviewSubmission {
  const byBlock = new Map(Object.entries(state.values ?? {}));

  const read = (field: { blockId: string; actionId: string }): MultiSelectStateValue => {
    const byAction = new Map(Object.entries(byBlock.get(field.blockId) ?? {}));
    return (byAction.get(field.actionId) ?? {}) as MultiSelectStateValue;
  };

  const channelsRaw = read(INTERVIEW_FIELDS.channels).selected_options ?? [];

  return {
    channels: channelsRaw
      .map((option) => option?.value ?? '')
      .filter((value) => value.length > 0 && isChannelId(value)),
    dailyWork: read(INTERVIEW_FIELDS.dailyWork).value ?? '',
    workStyle: read(INTERVIEW_FIELDS.workStyle).value ?? '',
  };
}

/* -------------------------------------------------------------------------- *
 * Validation
 * -------------------------------------------------------------------------- */

/**
 * Validation de la soumission.
 *
 * ⚠️ `sanitizeText` est appliqué ICI, au seuil, et non au moment d'écrire : ces deux textes
 * sont écrits par un humain et ressortent dans un DOCUMENT PDF ou DOCX, c'est-à-dire un canal
 * de sortie que `sanitizeAgentOutput` ne couvre PAS — il ne s'applique qu'à `response.text`.
 * C'est le trou exact qui laissait passer `[SECURITY_BLOCK]` et `DIRECTIVE 3.1` dans un PDF
 * généré, corrigé le 2026-08-11 côté modèle ; il vaut tout autant pour le texte d'un humain.
 *
 * Les trois champs sont OPTIONNELS. Une modale ouverte puis validée à vide est un « non
 * merci » parfaitement légitime, et la refuser n'apprendrait rien à personne.
 */
export const interviewSubmissionSchema = z.object({
  channels: z.array(z.string().regex(/^[CG][A-Z0-9]{2,}$/)).max(MAX_INTERVIEW_CHANNELS),
  dailyWork: z.string().trim().max(MAX_FREE_TEXT_CHARS).transform(sanitizeText),
  workStyle: z.string().trim().max(MAX_FREE_TEXT_CHARS).transform(sanitizeText),
});

export type ValidatedInterview = z.infer<typeof interviewSubmissionSchema>;
