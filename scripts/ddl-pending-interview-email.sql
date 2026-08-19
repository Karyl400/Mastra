-- ============================================================================
-- pending_interview_email — l'email préparé, en attente d'un « oui »
-- ============================================================================
--
-- Appliqué à la main, comme toutes les tables de ce dépôt : les migrations `drizzle/` sont
-- désynchronisées de `schema.ts`, et `drizzle-kit push` se BLOQUE indéfiniment contre une base
-- `libsql://` distante. Voir `CLAUDE.md`.
--
-- Rejouable : `IF NOT EXISTS` partout.
--
-- ⚠️ AUCUNE colonne pour le SUJET ni le CORPS, et c'est délibéré. Les stocker ferait de cette
-- table un moyen d'envoyer un texte arbitraire à une adresse arbitraire — la primitive que
-- toute la feature de recrutement est construite pour ne pas offrir. Ils sont RE-RENDUS par le
-- gabarit au moment de l'envoi, et la date RE-VALIDÉE.
--
-- ⚠️ Clé primaire sur la CONVERSATION : c'est dans ce fil qu'on répondra « oui ». Deux lignes
-- pour une même conversation rendraient ce « oui » ambigu.

CREATE TABLE IF NOT EXISTS pending_interview_email (
  conversation_id   TEXT PRIMARY KEY,
  requester_user_id TEXT    NOT NULL,
  to_email          TEXT    NOT NULL,
  candidate_name    TEXT,
  starts_at         TEXT    NOT NULL,
  position          TEXT,
  location          TEXT,
  reply_to          TEXT,
  created_at        INTEGER NOT NULL
);
