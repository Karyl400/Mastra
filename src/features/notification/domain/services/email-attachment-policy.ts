import type { EmailAttachment } from '../ports/providers';

/**
 * Borne de taille des pièces jointes email, commune à TOUS les fournisseurs.
 *
 * Elle vit dans le domaine et non dans un adaptateur : SMTP et Brevo doivent
 * refuser exactement les mêmes envois, sinon un basculement de fournisseur
 * changerait silencieusement ce que le produit accepte de livrer.
 *
 * ── Pourquoi 5 Mio ─────────────────────────────────────────────────────────
 * 1. L'envoi SMTP est une connexion TCP tenue depuis une fonction serverless,
 *    avec des timeouts à 10 s (`SMTP_TIMEOUT_MS`). Passé quelques mébioctets, le
 *    socket expire au milieu du transfert : l'appelant récolte un `ETIMEDOUT`
 *    opaque après 10 s d'attente, au lieu d'un refus immédiat et explicite.
 * 2. Le corps MIME est encodé en base64 (et le corps JSON de Brevo aussi) :
 *    +33 % sur le fil, et le tout est tenu en mémoire dans la fonction. 5 Mio de
 *    binaire, c'est déjà ~6,7 Mio transférés et un pic mémoire de l'ordre de
 *    12 Mio une fois l'original et son encodage coexistants.
 * 3. Gmail refuse au-delà de 25 Mio : on reste très en deçà, la borne n'est donc
 *    jamais la contrainte la plus stricte côté destinataire.
 * 4. Les documents réellement produits ici (guide d'intégration en PDF ou DOCX)
 *    pèsent quelques dizaines de kilo-octets — deux ordres de grandeur sous la
 *    borne. Un dépassement signale un contenu non borné en amont, c'est-à-dire un
 *    bug, pas un document légitime : échouer bruyamment est le bon comportement.
 *
 * La borne porte sur le TOTAL et non sur chaque pièce : c'est le volume transféré
 * qui fait expirer le socket, pas le nombre de fichiers.
 */
export const MAX_EMAIL_ATTACHMENTS_BYTES = 5 * 1024 * 1024;

function formatMib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mio`;
}

export function totalAttachmentBytes(attachments: readonly EmailAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachment.bytes.byteLength, 0);
}

/**
 * Lève AVANT toute E/S si le total dépasse la borne.
 *
 * Volontairement une exception et non un booléen : un refus silencieux
 * reproduirait le piège déjà documenté du projet (`emailSent: false` retourné
 * avec `status: 'success'`), où un envoi jamais parti passait pour un succès.
 * Le message nomme le total, la borne et les fichiers, faute de quoi le
 * diagnostic repart de zéro à chaque occurrence.
 */
export function assertEmailAttachmentsFit(attachments: readonly EmailAttachment[]): void {
  const total = totalAttachmentBytes(attachments);
  if (total <= MAX_EMAIL_ATTACHMENTS_BYTES) return;

  const names = attachments.map((attachment) => attachment.filename).join(', ');
  throw new Error(
    `Pièces jointes trop volumineuses : ${formatMib(total)} au total pour ${attachments.length} ` +
      `fichier(s) (${names}), la limite est ${formatMib(MAX_EMAIL_ATTACHMENTS_BYTES)}. ` +
      "L'envoi part d'une fonction serverless dont la connexion SMTP expire à 10 s : " +
      'au-delà de cette borne le socket lâche en cours de transfert. Réduire ou scinder le document.',
  );
}
