import { randomUUID } from 'node:crypto';
import { getDb, type DatabaseInstance } from '../database/connection';
import { auditLogs } from '../database/schema';
import { logger } from '../../shared/logger';

/**
 * ÉCRITURE DE LA PISTE D'AUDIT — la table existait, personne n'y écrivait.
 *
 * `audit_logs` porte 20 colonnes et 7 index depuis l'origine, pour ZÉRO ligne. Et le problème
 * n'était pas seulement qu'on avait oublié d'appeler un `insert` : `actorId` est `NOT NULL`, et
 * **aucune identité ne franchissait la frontière** — le handler appelait `agent.generate(texte)`,
 * le texte seul. Brancher l'écriture avant de faire circuler l'identité aurait produit une table
 * pleine de lignes sans acteur, ce qui est PIRE que vide : une piste d'audit qui ne désigne
 * personne donne l'illusion de la traçabilité sans en fournir aucune.
 *
 * L'ordre a donc été respecté : l'annuaire (`slack_directory`) et la politique d'accès d'abord,
 * l'écriture ensuite. Chaque ligne écrite ici nomme réellement quelqu'un.
 *
 * ## Ce qui est journalisé, et ce qui ne l'est pas
 *
 * On enregistre QUI, QUOI, et le VERDICT — jamais le texte du message. Le DM au bot est le
 * canal privilégié pour parler d'un salaire ou d'un litige ; le recopier dans une table
 * consultable transformerait un journal de sécurité en base de surveillance. C'est exactement
 * le grief RGPD que `PLAN-ARCHITECTURE.md` §4.7 oppose à l'ingestion de tous les canaux.
 * (Le texte est déjà journalisé en clair par `logger.info` sur ce chemin — c'est une dette
 * distincte, mais un log applicatif expire, une table non.)
 */
export interface AuditEntry {
  /** Verbe en majuscules : `SLACK_MESSAGE`, `AUTHZ_DENIED`, `RATE_LIMITED`. */
  action: string;
  /** Identifiant Slack de la personne. Jamais vide — c'est le point de tout le fichier. */
  actorId: string;
  actorType?: 'user' | 'system' | 'api' | 'webhook';
  resourceType?: string;
  resourceId?: string;
  status?: 'success' | 'failure' | 'denied';
  details?: Record<string, unknown>;
  requestId?: string;
  sessionId?: string;
  errorMessage?: string;
}

/**
 * Écrit une ligne d'audit. **NE LÈVE JAMAIS, et n'est jamais attendue sur le chemin critique.**
 *
 * Le raisonnement est le même que pour la déduplication partagée et le marqueur de progression :
 * une panne de la table d'audit ne doit pas devenir une panne du produit. Un journal manquant se
 * constate et se rattrape ; un bot muet a déjà coûté des heures à ce dépôt.
 *
 * ⚠️ La contrepartie est réelle et il faut la nommer : ce n'est PAS un journal d'audit de
 * conformité — un tel journal doit refuser l'action quand il ne peut pas l'enregistrer. C'est
 * une piste d'observabilité fiable en marche normale. La ligne à chercher quand elle manque :
 *     Audit log write failed
 */
export async function writeAuditLog(
  entry: AuditEntry,
  resolveDb: () => DatabaseInstance = getDb,
): Promise<void> {
  try {
    await resolveDb()
      .insert(auditLogs)
      .values({
        id: randomUUID(),
        action: entry.action,
        actorId: entry.actorId,
        actorType: entry.actorType ?? 'user',
        resourceType: entry.resourceType ?? null,
        resourceId: entry.resourceId ?? null,
        status: entry.status ?? 'success',
        details: entry.details ?? null,
        requestId: entry.requestId ?? null,
        sessionId: entry.sessionId ?? null,
        errorMessage: entry.errorMessage ?? null,
      });
  } catch (error) {
    logger.warn('Audit log write failed', { action: entry.action, error });
  }
}
