import type { SlackBlock } from '../providers/slack.adapter';
import {
  START_INTERVIEW_ACTION_ID,
  encodeInterviewPrefill,
  type InterviewPrefill,
} from './interview-modal';

/**
 * Le DM qui propose l'entretien, et la réponse rendue après la soumission.
 *
 * Séparé de `interview-modal.ts` pour la même raison qui sépare `profile-modal.ts` du
 * handler : la modale ne fait AUCUNE E/S et se teste sans serveur ni jeton, tandis que ces
 * textes-ci sont ce que la personne lit. Les mélanger ferait qu'un changement de formulation
 * traverserait un module qui n'a rien à voir avec la formulation.
 */

/** Texte de repli du DM. Slack ne s'en sert que pour la notification et les lecteurs d'écran. */
export const INTERVIEW_INVITE_TEXT =
  'Ton dossier est créé. Trois questions et je saurai de quoi te tenir au courant.';

/**
 * DM proposant l'entretien, posté après la création du dossier.
 *
 * ⚠️ Il ne part QUE si le dossier existe réellement — voir l'appelant. Proposer de « parler
 * de toi » à quelqu'un dont la création vient d'échouer serait la même faute que le
 * `emailSent: false` sous `status: 'success'` : une suite d'actions qui suppose un succès que
 * personne n'a vérifié.
 */
export function buildInterviewInviteBlocks(prefill: InterviewPrefill): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          "Ton dossier est créé. Il me manque une chose pour t'être utile : savoir ce qui " +
          "t'intéresse. Trois questions, et je t'ajoute aux canaux que tu choisis.",
      },
    } as SlackBlock,
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: START_INTERVIEW_ACTION_ID,
          style: 'primary',
          text: { type: 'plain_text', text: 'Parlons de toi' },
          value: encodeInterviewPrefill(prefill),
        },
      ],
    } as SlackBlock,
  ];
}

/**
 * Réponse après la soumission — elle NOMME ce qui s'est réellement passé.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi ce niveau de détail dans une simple confirmation
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ce dépôt a payé trois fois la même faute : `emailSent: false` noyé dans un run
 * `status: 'success'`, `documents.content` perdu en silence, `status = Sent` posé avant le
 * `try`. À chaque fois, une action annoncée n'avait pas eu lieu et rien ne le disait.
 *
 * Ici l'invitation à un canal PEUT échouer pour des raisons parfaitement banales — le bot
 * n'est pas membre du canal, le canal a été archivé depuis la dernière synchronisation
 * (26 des 32 canaux de l'inventaire le sont), la personne y est déjà. On distingue donc les
 * trois issues, et on ne prétend jamais avoir ajouté quelqu'un quelque part sans l'avoir fait.
 *
 * `already` n'est PAS un échec et n'est pas compté comme tel : Slack répond
 * `already_in_channel`, la personne y est, l'intention est satisfaite.
 */
export function interviewDoneReply(outcome: {
  joined: readonly string[];
  already: readonly string[];
  failed: readonly string[];
}): string {
  const parts: string[] = ["C'est noté, merci."];

  if (outcome.joined.length > 0) {
    parts.push(`Je t'ai ajouté à ${formatChannels(outcome.joined)}.`);
  }

  if (outcome.already.length > 0) {
    parts.push(`Tu étais déjà dans ${formatChannels(outcome.already)}.`);
  }

  if (outcome.failed.length > 0) {
    // On nomme les canaux manqués plutôt que d'annoncer un succès partiel : la personne peut
    // les rejoindre elle-même, ce qu'un silence lui interdirait de savoir.
    parts.push(
      `Je n'ai pas pu t'ajouter à ${formatChannels(outcome.failed)} — rejoins-les toi-même, ` +
        'ou dis-le-moi.',
    );
  }

  if (outcome.joined.length === 0 && outcome.already.length === 0 && outcome.failed.length === 0) {
    // Aucun canal coché : c'est un choix légitime, pas un échec. On ne relance pas.
    parts.push("Tu n'as choisi aucun canal — tu pourras revenir me le dire quand tu veux.");
  }

  return parts.join(' ');
}

/**
 * Échec d'ENREGISTREMENT.
 *
 * ⚠️ Ne jamais retomber sur `interviewDoneReply` : annoncer « c'est noté » sans avoir écrit
 * ferait cesser de redemander, et la personne repartirait en croyant le bot informé.
 */
export const INTERVIEW_FAILED_REPLY =
  "Je n'ai pas réussi à enregistrer tes réponses — ma base est indisponible à l'instant. " +
  'Redis-le-moi dans un moment.';

/** `#a, #b et #c` — la conjonction française, parce que ce texte est lu par un humain. */
function formatChannels(names: readonly string[]): string {
  const marked = names.map((name) => `#${name}`);
  if (marked.length === 1) return marked[0]!;
  return `${marked.slice(0, -1).join(', ')} et ${marked.at(-1)}`;
}
