-- ============================================================================
-- pinned_facts — mémoire longue, HORS du TTL de 60 minutes
-- ============================================================================
--
-- Exporté depuis `src/infrastructure/database/schema.ts`. À appliquer AVANT le déploiement :
-- une fois la table déclarée dans le schéma Drizzle, le code la nomme, et un `INSERT` sur une
-- table absente échoue en `no such table: pinned_facts`. C'est la leçon de `documents.content`,
-- où l'ordre inverse avait produit une perte muette sur 6 lignes sur 6.
--
--     npx tsx --env-file=.env scripts/apply-ddl.mts scripts/ddl-pinned-facts.sql
--
-- REJOUABLE : `IF NOT EXISTS` partout. Une seconde exécution ne fait rien et n'échoue pas.
--
-- ⚠️ `drizzle-kit push` se BLOQUE indéfiniment contre une base `libsql://` distante (sans
-- erreur, il ne rend jamais la main) : ce fichier est le seul chemin d'application en
-- production, comme pour `conversation_turns`, `slack_event_dedup` et `slack_directory`.

CREATE TABLE IF NOT EXISTS pinned_facts (
  id            TEXT PRIMARY KEY,
  slack_user_id TEXT    NOT NULL,
  fact          TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Sert les deux accès : lecture des faits d'une personne (égalité + tri) et éviction du plus
-- ancien quand le plafond de 5 est atteint. Pas d'index sur `created_at` seul — rien ne purge
-- cette table par l'âge, et c'est tout son objet.
CREATE INDEX IF NOT EXISTS idx_pinned_facts_user_created_at
  ON pinned_facts (slack_user_id, created_at);
