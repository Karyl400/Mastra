-- Archive des messages de canal — la base de connaissance interrogée par knowledgeAgent.
-- Rejouable : IF NOT EXISTS partout.

CREATE TABLE IF NOT EXISTS channel_messages (
  id            TEXT PRIMARY KEY,           -- `${channel}:${ts}` : la prise est idempotente
  channel_id    TEXT NOT NULL,
  slack_user_id TEXT,
  text          TEXT NOT NULL,
  thread_ts     TEXT,
  posted_at     INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  embedding     F32_BLOB(1024)              -- vide tant qu'aucun fournisseur d'embedding
);

CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages (channel_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_channel_messages_user    ON channel_messages (slack_user_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_channel_messages_created ON channel_messages (created_at);

-- Index plein texte. `unicode61 remove_diacritics 2` : « décidé » doit se trouver par
-- « decide ». Le tokenizer par défaut ne replie pas les diacritiques, et ce dépôt a déjà
-- payé trois fois le piège des accents.
CREATE VIRTUAL TABLE IF NOT EXISTS channel_messages_fts
  USING fts5(text, content='channel_messages', content_rowid='rowid',
             tokenize='unicode61 remove_diacritics 2');

-- Les triggers s'exécutent dans la transaction implicite de l'instruction : l'archive et son
-- index ne peuvent pas diverger, alors qu'il n'existe AUCUNE transaction explicite dans ce
-- dépôt et qu'une fonction Vercel peut être gelée entre deux écritures.
CREATE TRIGGER IF NOT EXISTS channel_messages_ai AFTER INSERT ON channel_messages BEGIN
  INSERT INTO channel_messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS channel_messages_ad AFTER DELETE ON channel_messages BEGIN
  INSERT INTO channel_messages_fts(channel_messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS channel_messages_au AFTER UPDATE ON channel_messages BEGIN
  INSERT INTO channel_messages_fts(channel_messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO channel_messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
