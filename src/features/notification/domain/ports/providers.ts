/**
 * Pièce jointe d'un email, exprimée dans les termes du domaine.
 *
 * `Uint8Array` et non `Buffer` : la couche domaine reste indépendante des types
 * Node — c'est le même arbitrage que `RenderedDocument` côté rendu de document.
 * Chaque adaptateur convertit vers ce que son transport attend (Buffer pour
 * nodemailer, base64 pour l'API Brevo).
 */
export interface EmailAttachment {
  filename: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface EmailProvider {
  /**
   * `attachments` est OPTIONNEL, et doit le rester : les appelants historiques
   * (`send-notification`, workflow d'onboarding) n'ont pas été modifiés et
   * doivent continuer à compiler et à produire exactement le même message.
   *
   * La taille totale est bornée — voir `domain/services/email-attachment-policy.ts`.
   */
  sendEmail(
    to: string,
    subject: string,
    body: string,
    attachments?: EmailAttachment[],
  ): Promise<void>;
}

export interface ChatProvider {
  /**
   * ⚠️ Rend le CANAL réellement utilisé. Quand `channelId` est un identifiant d'UTILISATEUR
   * (`U…`), Slack ouvre lui-même la conversation directe et le message atterrit dans un canal
   * `D…` que l'appelant ne connaissait pas. C'est ce qui a cassé l'entretien conversationnel
   * à sa première mise en production : la question était posée à `U…`, l'état était cherché
   * dans la mémoire de `D…`, et les deux ne se rencontraient jamais.
   */
  sendMessage(channelId: string, text: string): Promise<{ channel: string }>;
}

export interface FileUploadInput {
  /** Canal de destination. En DM, l'identifiant `D…` du fil. */
  channel: string;
  /** Fourni pour livrer le fichier DANS le fil plutôt qu'à la racine du canal. */
  threadTs?: string;
  bytes: Uint8Array;
  filename: string;
  title?: string;
  initialComment?: string;
}

/**
 * Livraison d'un fichier dans la conversation.
 *
 * Le port ne mentionne aucun type `@slack/*` — la règle de dépendance l'interdit
 * dans `domain/`, et un garde-fou de test la verrouille
 * (`tests/unit/quality/architecture.test.ts`).
 *
 * `permalink` est optionnel : le fichier peut être livré alors que la réponse du
 * fournisseur ne porte pas d'URL. L'absence de lien n'est donc PAS un échec.
 */
export interface FileUploadProvider {
  uploadFile(input: FileUploadInput): Promise<{ permalink?: string }>;
}
