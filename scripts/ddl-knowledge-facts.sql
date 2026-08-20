-- Niveau 2 de la base de connaissance : l'information PERTINENTE, déjà distillée et formatée.
--
-- Le niveau 1 (`channel_messages`) garde tout ce qui a été dit en canal, mot pour mot : c'est
-- ce qui survit à la suppression d'un message. Cette table-ci ne garde que ce qui porte de
-- l'information (décision, engagement, blocage, échéance, question ouverte) et le garde SOUS
-- SA FORME FINALE. À la demande, l'agent lit une ligne déjà écrite ; il ne refait pas le
-- travail de sélection au moment où quelqu'un attend une réponse.
--
-- La distillation est du CODE (`fact-distillation.ts`, `excerpt-salience.ts`), donc elle coûte
-- ZÉRO token. Le poste dominant de ce dépôt est le nombre d'étapes de modèle ; un appel de
-- modèle par message ingéré serait le contraire exact de la doctrine.
--
-- Rejouable : IF NOT EXISTS partout.

CREATE TABLE IF NOT EXISTS knowledge_facts (
  id            TEXT PRIMARY KEY,           -- `${channel}:${ts}`, la MÊME clé qu'au niveau 1
  channel_id    TEXT NOT NULL,
  slack_user_id TEXT,
  kind          TEXT NOT NULL,              -- decision | engagement | blocage | echeance | question
  summary       TEXT NOT NULL,
  score         INTEGER NOT NULL,
  posted_at     INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  embedding     F32_BLOB(1024)              -- vide tant qu'aucun fournisseur d'embedding
);

CREATE INDEX IF NOT EXISTS idx_knowledge_facts_channel ON knowledge_facts (channel_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_facts_user    ON knowledge_facts (slack_user_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_facts_score   ON knowledge_facts (score, posted_at);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_facts_fts
  USING fts5(summary, content='knowledge_facts', content_rowid='rowid',
             tokenize='unicode61 remove_diacritics 2');

CREATE TRIGGER IF NOT EXISTS knowledge_facts_ai AFTER INSERT ON knowledge_facts BEGIN
  INSERT INTO knowledge_facts_fts(rowid, summary) VALUES (new.rowid, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_facts_ad AFTER DELETE ON knowledge_facts BEGIN
  INSERT INTO knowledge_facts_fts(knowledge_facts_fts, rowid, summary) VALUES ('delete', old.rowid, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_facts_au AFTER UPDATE ON knowledge_facts BEGIN
  INSERT INTO knowledge_facts_fts(knowledge_facts_fts, rowid, summary) VALUES ('delete', old.rowid, old.summary);
  INSERT INTO knowledge_facts_fts(rowid, summary) VALUES (new.rowid, new.summary);
END;
