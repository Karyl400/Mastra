/**
 * L'email préparé et NON ENVOYÉ, en attente d'un oui.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi une TABLE, alors que tout le reste du parcours lit le fil
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Les deux machines à états de l'accueil (`profile-chat`, `interview-chat`) n'ont AUCUNE table :
 * leur état est le dernier tour `assistant` du fil, ce qui est gratuit et suffisant tant que
 * l'état ne survit pas à une digression.
 *
 * Ici il doit y survivre, et c'est une exigence explicite : « en cas de changement de sujet,
 * faire un rappel sur l'email à envoyer, et si l'utilisateur veut changer de sujet, changer de
 * sujet et garder l'email en suspens ». Un état qui doit tenir pendant qu'on parle d'autre chose
 * ne peut pas être le dernier message du bot — par définition, ce n'est plus lui.
 *
 * ⚠️ ON NE STOCKE QUE DES CHAMPS, JAMAIS LE CORPS. C'est le contrat que portait déjà le `value`
 * du bouton, et sa raison n'a pas changé : transporter le corps ferait de cette table un moyen
 * d'envoyer un texte arbitraire à une adresse arbitraire — la primitive que toute la feature est
 * construite pour ne pas offrir. Le sujet et le corps sont RE-RENDUS à l'envoi par le gabarit,
 * et la date RE-VALIDÉE.
 *
 * ⚠️ Une ligne par CONVERSATION, pas par personne : c'est la conversation qui porte le fil du
 * dialogue, et c'est dans ce fil qu'on répondra « oui ». Une seconde préparation dans la même
 * conversation REMPLACE la première — l'humain n'en voit qu'une à l'écran.
 */
/**
 * Au-delà de cette ancienneté, une préparation est ABANDONNÉE.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi une borne, et pourquoi celle-là
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Sans elle, une préparation ne meurt jamais. Deux conséquences, et la seconde est celle qui
 * se voit :
 *
 *  1. La ligne reste sur la Turso indéfiniment — c'est l'adresse email d'un NON-SALARIÉ, une
 *     donnée personnelle sans chemin d'effacement (`forget()` ne l'emporte pas : elle n'est
 *     pas dans la conversation). Le dépôt recense déjà ce trou pour `notifications` et
 *     `documents` ; on ne l'agrandit pas.
 *  2. Le RAPPEL est accolé à chaque réponse d'agent tant que la préparation vit. Un email
 *     préparé puis oublié ferait donc répéter la même parenthèse à l'infini — le bruit qui
 *     s'ignore, exactement ce que le rappel existe pour éviter.
 *
 * 24 heures : au-delà, la personne a changé de journée, et redemander lui coûte un message
 * là où la relecture d'un email préparé la veille ne veut plus dire grand-chose. La borne est
 * VÉRIFIÉE À LA LECTURE, jamais par un balayage : ce projet n'a aucun cron, et une purge qui
 * dépend d'un automate inexistant est la promesse creuse que ce dépôt traque.
 */
export const PENDING_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingInterviewEmail {
  readonly conversationId: string;
  /** Qui a demandé. Seul lui peut confirmer — la conversation peut avoir des témoins. */
  readonly requesterUserId: string;
  readonly to: string;
  readonly candidateName?: string | null;
  /** ISO. RE-VALIDÉ à l'envoi, jamais rejoué sur confiance. */
  readonly startsAt: string;
  readonly position?: string | null;
  readonly location?: string | null;
  readonly replyTo?: string | null;
  readonly createdAt: Date;
}

export interface PendingInterviewEmailRepository {
  /** Écrase la préparation précédente de la même conversation, s'il y en a une. */
  save(pending: PendingInterviewEmail): Promise<void>;

  find(conversationId: string): Promise<PendingInterviewEmail | null>;

  /**
   * Retire la préparation et rend le NOMBRE de lignes touchées.
   *
   * ⚠️ Le compte est le contrat, comme pour `forget(scope)` et `linkEmployee`. C'est lui qui
   * rend la prise ATOMIQUE : deux « oui » traités par deux instances ne peuvent pas envoyer
   * deux fois, la seconde suppression rendant 0. Sans lui, on ne pourrait que réciter.
   */
  clear(conversationId: string): Promise<number>;
}
