/**
 * Comment une invitation d'entretien est PRÉSENTÉE pour relecture, avant envoi.
 *
 * ## Pourquoi un port pour deux fonctions
 *
 * `scheduleCandidateInterview` (couche `application`) importait directement
 * `buildInterviewConfirmBlocks` depuis `infrastructure/handlers/` — l'unique violation de la
 * règle de dépendance de tout le dépôt, relevée le 2026-08-18. Elle passait parce que le test
 * d'architecture ne surveillait que `domain/` ; il couvre désormais `application/` aussi.
 *
 * Ce n'est pas du purisme. Ce tool ne dépend pas d'une carte Block Kit, il dépend de l'idée
 * qu'« un humain relit avant que ça parte » — et c'est la SEULE garantie de toute la feature :
 * le modèle ne fournit aucune prose sortante, le corps est rendu par un gabarit, et rien ne
 * part sans un clic. Cette garantie ne doit pas être attachée à Slack.
 *
 * ⚠️ `Block` reste `unknown[]` : le domaine n'a aucune raison de connaître la forme d'un bloc
 * Slack. Il déclare qu'une confirmation se PRÉSENTE ; l'infrastructure sait avec quoi.
 */
export interface InterviewConfirmationPayload {
  readonly to: string;
  readonly candidateName?: string;
  /** ISO — revalidé à l'envoi, jamais rejoué sur confiance. */
  readonly startsAt: string;
  readonly position?: string;
  readonly location?: string;
  readonly replyTo?: string;
  /** Comparé à l'auteur du CLIC : la carte est visible de tous ceux qui voient le fil. */
  readonly requesterUserId: string;
}

export interface InterviewConfirmationPresenter {
  /**
   * Les blocs de la carte de relecture.
   *
   * ⚠️ L'email est affiché INTÉGRALEMENT, corps compris. Un résumé (« un email va partir à
   * Jean ») rendrait la confirmation décorative : on ne peut pas relire ce qu'on ne voit pas,
   * et c'est la relecture qui est la valeur de cette étape.
   */
  buildBlocks(input: {
    payload: InterviewConfirmationPayload;
    humanReadableDate: string;
    subject: string;
    body: string;
  }): unknown[];

  /** Texte de repli : Slack l'utilise pour l'aperçu et les lecteurs d'écran. */
  fallbackText(candidateName?: string): string;
}
