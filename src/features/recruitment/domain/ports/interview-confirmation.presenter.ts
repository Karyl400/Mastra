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
 * ⚠️ IL NE REND PLUS DES BLOCS MAIS DU TEXTE — 2026-08-19. Les boutons ont été retirés du
 * produit : la relecture se conclut désormais par une QUESTION à laquelle on répond oui ou non.
 * Le port n'en est pas affaibli, il est même plus fidèle à ce qu'il déclare : il portait déjà
 * « une confirmation se PRÉSENTE, l'infrastructure sait avec quoi », et la réponse est
 * maintenant du texte plutôt qu'une carte. La garantie — un humain relit avant que ça parte —
 * est inchangée.
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
   * Le texte de relecture, terminé par la QUESTION.
   *
   * ⚠️ L'email est affiché INTÉGRALEMENT, corps compris. Un résumé (« un email va partir à
   * Jean ») rendrait la confirmation décorative : on ne peut pas relire ce qu'on ne voit pas,
   * et c'est la relecture qui est la valeur de cette étape.
   */
  buildConfirmationText(input: {
    payload: InterviewConfirmationPayload;
    humanReadableDate: string;
    subject: string;
    body: string;
  }): string;

  /** Texte de repli : Slack l'utilise pour l'aperçu et les lecteurs d'écran. */
  fallbackText(candidateName?: string): string;
}
