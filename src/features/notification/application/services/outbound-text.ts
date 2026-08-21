import {
  sanitizeNotificationBody,
  sanitizeNotificationSubject,
  type SanitizedDocumentText,
} from '../../../../shared/security/agent-output';
import { logger } from '../../../../shared/logger';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE POINT UNIQUE PAR OÙ PASSE TOUTE PROSE DE MODÈLE QUI SORT DU PRODUIT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Trois chemins expédient un couple sujet/corps rédigé par le modèle : `sendNotification`
 * (immédiat), `scheduleReminder` (écriture) et `dispatchDueReminders` (remise, le lendemain).
 * Avant le 2026-08-21 ils avaient trois traitements DIFFÉRENTS — le premier filtrait son corps
 * et pas son sujet, les deux autres ne filtraient rien.
 *
 * ⚠️ **Ce module existe pour qu'il n'y ait plus rien à oublier.** La leçon est celle que ce
 * dépôt a déjà tirée pour `email-attachment-policy` : une borne écrite dans un adaptateur laisse
 * l'autre adaptateur libre de diverger, et le jour où l'on bascule de fournisseur, le produit
 * change silencieusement ce qu'il accepte de livrer. Ici, c'est ce qu'il accepte d'ÉMETTRE.
 *
 * ⚠️ **Le journal est en `error`, pas en `warn`, et c'est délibéré** : une notification assainie
 * signifie qu'un modèle a produit un marqueur interne ou un lien hors liste blanche dans un
 * texte destiné à un humain. Ce n'est jamais normal, même quand le filtre a fait son travail.
 */
export interface SafeOutboundText {
  readonly subject: string;
  readonly body: string;
  readonly redacted: readonly string[];
  readonly strippedUrls: readonly string[];
}

function merge(
  subject: SanitizedDocumentText,
  body: SanitizedDocumentText,
): { redacted: string[]; strippedUrls: string[] } {
  return {
    redacted: [...new Set([...subject.redacted, ...body.redacted])],
    strippedUrls: [...new Set([...subject.strippedUrls, ...body.strippedUrls])],
  };
}

/**
 * Assainit le couple et journalise si quelque chose a été retiré.
 *
 * `context` sert uniquement au diagnostic — il ne doit porter que des identifiants, jamais la
 * prose elle-même : `maskPii` masque par NOM DE CLÉ, et une clé inventée ici échapperait au
 * masquage. C'est le défaut trouvé sur `inputPreview` le 2026-08-21.
 */
export function safeOutboundText(
  raw: { subject: string; body: string },
  context: Record<string, string | undefined>,
): SafeOutboundText {
  const subject = sanitizeNotificationSubject(raw.subject);
  const body = sanitizeNotificationBody(raw.body);
  const { redacted, strippedUrls } = merge(subject, body);

  if (redacted.length > 0 || strippedUrls.length > 0) {
    logger.error('Texte sortant assaini', { ...context, redacted, strippedUrls });
  }

  return { subject: subject.text, body: body.text, redacted, strippedUrls };
}
