import { and, desc, eq, gte } from 'drizzle-orm';

import { getDb } from '../../../../infrastructure/database/connection';
import { conversationTurns } from '../../../../infrastructure/database/schema';
import type { ConversationTurnRow } from '../../../../infrastructure/database/schema';
import type {
  BotMemoryReadOptions,
  BotMemoryReadPort,
  BotMemoryRole,
  BotMemoryTurn,
} from '../../domain/ports/bot-memory.repository';

/**
 * Lecture de `conversation_turns` — la mémoire que le bot tient déjà pour son
 * propre fonctionnement.
 *
 * ── Aucune table nouvelle, aucune écriture ──────────────────────────────────
 * La table existe et est appliquée sur la Turso de production depuis le
 * 2026-08-11 (`scripts/ddl-conversation-turns.sql`). Cette feature n'ajoute rien
 * au schéma et n'écrit rien : c'est ce qui la distingue d'une « ingestion de
 * tous les canaux », qui déclencherait AIPD et consultation du CSE
 * (`PLAN-ARCHITECTURE.md` §4.7).
 *
 * ── La requête, et pourquoi elle est écrite ainsi ───────────────────────────
 * Égalité sur `conversation_id` + borne sur `created_at` : exactement l'index
 * `idx_conversation_turns_conversation_created_at`, dans cet ordre de colonnes.
 *
 * `ORDER BY created_at DESC` puis `LIMIT` : on veut les tours les plus RÉCENTS.
 * Un `LIMIT` sur un tri croissant ramènerait le DÉBUT du fil, c'est-à-dire ce
 * qu'on veut oublier — c'est la remarque déjà portée par
 * `DrizzleConversationRepository.recentTurns`. Les lignes sont ensuite remises à
 * l'endroit : le port promet du plus ancien au plus récent.
 *
 * ⚠️ Il y a TOUJOURS un `ORDER BY`. `getNotificationHistory` n'en avait aucun :
 * deux appels identiques pouvaient rendre deux ordres différents, donc deux
 * tool-results différents pour la même question.
 */
export class DrizzleBotMemoryRepository implements BotMemoryReadPort {
  async recentDirectTurns(
    dmChannelId: string,
    options: BotMemoryReadOptions,
  ): Promise<BotMemoryTurn[]> {
    if (options.limit <= 0) return [];

    // Défense en profondeur : le tool vérifie déjà l'invariant, mais un port dont
    // l'invariant n'est contrôlé que chez l'appelant finit par être appelé sans.
    // Une clé de fil (`C…:1734…`) servirait du contenu de canal sans contrôle
    // d'appartenance — le deputy confus, par la porte de derrière.
    if (!dmChannelId.startsWith('D')) return [];

    const db = getDb();
    const cutoff = new Date(Date.now() - options.sinceMs);

    const rows = await db
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.conversationId, dmChannelId),
          gte(conversationTurns.createdAt, cutoff),
        ),
      )
      .orderBy(desc(conversationTurns.createdAt))
      .limit(options.limit);

    return rows.reverse().map(toDomain);
  }
}

function toDomain(row: ConversationTurnRow): BotMemoryTurn {
  return {
    // SQLite ne connaît pas les unions littérales : la colonne est un `text`
    // libre, la contrainte vit dans le domaine.
    role: row.role as BotMemoryRole,
    text: row.content,
    slackUserId: row.slackUserId ?? null,
    at: row.createdAt,
  };
}
