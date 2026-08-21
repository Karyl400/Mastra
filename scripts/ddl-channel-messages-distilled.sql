-- Second rideau de distillation : marque les messages déjà examinés par le modèle.
--
-- ⚠️ ORDRE IMPOSÉ — DDL D'ABORD, DÉPLOIEMENT ENSUITE.
-- Une fois `distilled_at` déclarée dans `schema.ts`, Drizzle la NOMME dans l'INSERT :
-- l'archivage échoue en `no such column` tant que la base n'est pas migrée. C'est le bon
-- comportement (échec bruyant plutôt que perte muette), mais il faut respecter l'ordre.
-- Même piège que `documents.content` le 2026-08-11.
--
-- ⚠️ SQLite n'a pas d'`ADD COLUMN IF NOT EXISTS` : rejouer ce fichier échoue avec
-- `duplicate column name: distilled_at`. Cette erreur est BÉNIGNE — elle signifie que c'est
-- déjà fait.
--
-- NULL = jamais examiné par le second rideau. Nullable à dessein : les lignes existantes n'ont
-- rien à rattraper, et un NOT NULL exigerait une valeur de remplissage, c'est-à-dire de
-- déclarer examiné ce qui ne l'a pas été.
ALTER TABLE channel_messages ADD COLUMN distilled_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_channel_messages_pending
  ON channel_messages (distilled_at, posted_at);
