/**
 * LA CARTE DE CONFIRMATION — le dernier point où un humain voit l'email avant qu'il ne parte.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi une confirmation, alors que la demande disait « envoie »
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ce dépôt vient de passer une campagne entière sur un bug où un document est parti à la
 * MAUVAISE ADRESSE parce que le modèle avait choisi le mauvais identifiant — les dix documents
 * de la base portent le même UUID, dont un intitulé « Bienvenue Awa ». Ici, l'adresse n'est
 * même plus contrainte par un annuaire : elle est libre, elle sort de l'entreprise, et
 * l'envoi est IRRÉVERSIBLE.
 *
 * Les deux fautes qu'un humain voit en une seconde et qu'aucun code ne peut attraper :
 *   - l'adresse est celle d'un homonyme, ou comporte une coquille ;
 *   - la date est le bon jour de la mauvaise semaine.
 *
 * Le coût de la parade est UN CLIC et **zéro token** — Block Kit ne passe par aucun modèle.
 *
 * ⚠️ La carte est postée là où la demande a été faite. En canal, cela signifie que des tiers
 * la voient : c'est délibéré et sans risque ici, contrairement à la modale de profil dont le
 * `value` porte les données personnelles de quelqu'un (d'où sa restriction au DM). Ce qui est
 * affiché ici est une convocation que le demandeur vient lui-même de dicter.
 */

export const SEND_INTERVIEW_ACTION_ID = 'send_interview_email';
export const CANCEL_INTERVIEW_ACTION_ID = 'cancel_interview_email';

/**
 * Ce que le bouton transporte. Il voyage dans le `value` du bloc Slack et revient signé par
 * Slack — c'est le même modèle de confiance que le pré-remplissage du profil.
 *
 * ⚠️ `requesterUserId` n'est PAS décoratif : il est comparé à l'auteur du CLIC. Sans lui,
 * n'importe quel témoin d'un canal pourrait déclencher un envoi vers l'extérieur au nom de
 * l'entreprise — la carte est visible de tous ceux qui voient le fil.
 */
export interface InterviewConfirmPayload {
  readonly to: string;
  readonly candidateName: string;
  /** ISO — revalidé à l'envoi, jamais rejoué sur confiance. */
  readonly startsAt: string;
  readonly position?: string;
  readonly location?: string;
  readonly replyTo?: string;
  readonly requesterUserId: string;
}

/**
 * Slack borne le `value` d'un bouton à 2 000 caractères. On l'encode en JSON compact et on
 * VÉRIFIE la borne à la construction plutôt que de découvrir la troncature au clic — Slack
 * rejette la vue entière au-delà, ce qui se manifesterait par « le bouton ne fait rien ».
 */
const MAX_VALUE_CHARS = 2000;

export function encodeInterviewConfirm(payload: InterviewConfirmPayload): string {
  const encoded = JSON.stringify(payload);
  if (encoded.length > MAX_VALUE_CHARS) {
    throw new Error(
      `Charge de confirmation trop longue (${encoded.length} > ${MAX_VALUE_CHARS}) : ` +
        'Slack refuserait le bloc. Raccourcis le lieu ou le poste.',
    );
  }
  return encoded;
}

/** ⚠️ Ne lève jamais : un `value` illisible doit produire un refus lisible, pas une 500. */
export function decodeInterviewConfirm(raw: string | undefined): InterviewConfirmPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<InterviewConfirmPayload>;
    if (
      typeof parsed?.to !== 'string' ||
      typeof parsed?.candidateName !== 'string' ||
      typeof parsed?.startsAt !== 'string' ||
      typeof parsed?.requesterUserId !== 'string'
    ) {
      return null;
    }
    return parsed as InterviewConfirmPayload;
  } catch {
    return null;
  }
}

interface Block {
  type: string;
  [key: string]: unknown;
}

/**
 * ⚠️ L'email est affiché INTÉGRALEMENT, corps compris. Montrer un résumé (« un email va partir
 * à Jean ») rendrait la confirmation décorative : on ne peut pas relire ce qu'on ne voit pas,
 * et c'est précisément la relecture qui est la valeur de cette étape.
 */
export function buildInterviewConfirmBlocks(input: {
  payload: InterviewConfirmPayload;
  humanReadableDate: string;
  subject: string;
  body: string;
}): Block[] {
  const facts = [`*À* ${input.payload.to}`, `*Quand* ${input.humanReadableDate}`];
  if (input.payload.position) facts.push(`*Poste* ${input.payload.position}`);
  if (input.payload.location) facts.push(`*Lieu* ${input.payload.location}`);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Entretien à envoyer* — relis avant d'envoyer, l'envoi est définitif.\n\n${facts.join('\n')}`,
      },
    },
    {
      type: 'section',
      // Bloc de code : le corps n'est ni interprété comme du mrkdwn ni tronqué en silence.
      text: { type: 'mrkdwn', text: `\`\`\`${input.subject}\n\n${input.body}\`\`\`` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: SEND_INTERVIEW_ACTION_ID,
          style: 'primary',
          text: { type: 'plain_text', text: 'Envoyer' },
          value: encodeInterviewConfirm(input.payload),
          // Slack redemande confirmation côté client : le second garde-fou est gratuit, et
          // celui-ci protège du clic accidentel plutôt que de l'erreur de contenu.
          confirm: {
            title: { type: 'plain_text', text: 'Envoyer cet email ?' },
            text: { type: 'mrkdwn', text: `Il partira à *${input.payload.to}*. C'est définitif.` },
            confirm: { type: 'plain_text', text: 'Envoyer' },
            deny: { type: 'plain_text', text: 'Annuler' },
          },
        },
        {
          type: 'button',
          action_id: CANCEL_INTERVIEW_ACTION_ID,
          text: { type: 'plain_text', text: 'Annuler' },
          value: 'cancel',
        },
      ],
    },
  ];
}

/** Repli de notification : Slack l'utilise pour l'aperçu et les lecteurs d'écran. */
export function interviewConfirmFallback(candidateName: string): string {
  return `Entretien à confirmer pour ${candidateName}`;
}

export const INTERVIEW_SENT_REPLY = (to: string, whenLabel: string): string =>
  `C'est envoyé à ${to}, pour ${whenLabel}.`;

export const INTERVIEW_CANCELLED_REPLY = "Annulé — aucun email n'est parti.";

/**
 * ⚠️ Ce refus existe parce que la carte est visible de tous ceux qui voient le fil. Un témoin
 * ne doit pas pouvoir écrire à l'extérieur au nom de l'entreprise.
 */
export const INTERVIEW_NOT_YOURS_REPLY =
  "Cette invitation n'est pas la tienne : seule la personne qui l'a préparée peut l'envoyer.";

export const INTERVIEW_SEND_FAILED_REPLY =
  "Je n'ai pas pu envoyer l'email — rien n'est parti. Réessaie, ou préviens l'équipe technique.";
