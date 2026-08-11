-- ============================================================================
-- conversation_turns — mémoire conversationnelle (feature `conversation`, lot 1)
-- ============================================================================
--
-- POURQUOI CE FICHIER EXISTE, plutôt qu'une migration `drizzle/` :
--
--   1. Les migrations `drizzle/` sont DÉSYNCHRONISÉES de `src/infrastructure/database/schema.ts`
--      (0000_*.sql crée `employees` avec 11 colonnes, le schéma en déclare 20). Les appliquer
--      sur une base vierge échoue. `npm run db:generate` exige en plus un vrai TTY, drizzle-kit
--      posant des questions « added vs renamed ».
--   2. `drizzle-kit push` SE BLOQUE contre une base `libsql://` distante (dialect `sqlite`) :
--      aucune erreur, il ne rend jamais la main. Le schéma de la Turso de production a déjà dû
--      être appliqué de cette façon — en exécutant le DDL exporté depuis `schema.ts`.
--
-- Ce DDL est donc l'équivalent EXACT de la table `conversationTurns` de `schema.ts`, à appliquer
-- à la main. Il est idempotent (`IF NOT EXISTS`) : le rejouer ne coûte rien.
--
-- ----------------------------------------------------------------------------
-- APPLICATION
-- ----------------------------------------------------------------------------
--
--   Base locale :
--       sqlite3 data/kisso.db < scripts/ddl-conversation-turns.sql
--
--   Turso / LibSQL distant (le blocage de `drizzle-kit push` ne concerne PAS le client turso) :
--       turso db shell <nom-de-la-base> < scripts/ddl-conversation-turns.sql
--
--   Vérification (filtrer sur `tbl_name` et NON sur `name` : les index ne portent pas le
--   préfixe de la table, un `name LIKE 'conversation_turns%'` les manquerait tous) :
--       SELECT type, name FROM sqlite_master WHERE tbl_name = 'conversation_turns';
--       -- attendu : table conversation_turns,
--       --           index idx_conversation_turns_conversation_created_at,
--       --           index idx_conversation_turns_created_at
--       --           (+ sqlite_autoindex_conversation_turns_1, créé par la PRIMARY KEY)
--
--   APPLIQUÉ SUR LA TURSO DE PRODUCTION le 2026-08-11 : table et 2 index vérifiés présents.
--
-- ----------------------------------------------------------------------------
-- NOTE SUR `created_at`
-- ----------------------------------------------------------------------------
-- INTEGER = millisecondes depuis l'epoch (Drizzle `mode: 'timestamp_ms'`), et non le `TEXT`
-- `datetime('now')` des 10 autres tables : l'horodatage est ici le discriminant du TTL ET de
-- l'ordre des tours, or `datetime('now')` a une résolution à la seconde — deux messages d'un
-- même échange y seraient à égalité et l'ordre chronologique deviendrait indéterminé.
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversation_turns (
    id              text    PRIMARY KEY NOT NULL,
    conversation_id text    NOT NULL,
    role            text    NOT NULL,
    content         text    NOT NULL,
    agent_id        text    NOT NULL,
    slack_user_id   text,
    created_at      integer NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_conversation_created_at
    ON conversation_turns (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_created_at
    ON conversation_turns (created_at);
