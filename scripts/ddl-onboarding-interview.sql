-- ============================================================================
-- onboarding_interview — entretien post-profil
-- ============================================================================
--
-- Exporté depuis `src/infrastructure/database/schema.ts`. À appliquer AVANT le déploiement :
-- une fois la table déclarée dans le schéma Drizzle, le code la NOMME, et un `INSERT` sur une
-- table absente échoue en `no such table: onboarding_interview`. Leçon de `documents.content`,
-- où l'ordre inverse avait produit une perte muette sur 6 lignes sur 6.
--
--     npx tsx --env-file=.env scripts/apply-ddl.mts scripts/ddl-onboarding-interview.sql
--
-- REJOUABLE : `IF NOT EXISTS`. Une seconde exécution ne fait rien et n'échoue pas.
--
-- ⚠️ `employee_id` est la PRIMARY KEY, pas un `id` technique : un employé a UN entretien.
-- L'upsert en devient trivial et l'unicité structurelle plutôt que conventionnelle.
--
-- ⚠️ Aucune clé étrangère vers `employees`. Le reste du schéma en déclare, mais SQLite ne les
-- applique que si `PRAGMA foreign_keys=ON`, ce que le pilote libsql ne pose pas : elles y sont
-- décoratives. Une contrainte qu'on croit active et qui ne l'est pas est pire que son absence.

CREATE TABLE IF NOT EXISTS onboarding_interview (
  employee_id   TEXT PRIMARY KEY,
  slack_user_id TEXT    NOT NULL,
  channels      TEXT    NOT NULL,
  daily_work    TEXT    NOT NULL DEFAULT '',
  work_style    TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Sert l'effacement par personne et la relecture depuis un identifiant Slack, seul disponible
-- sur le chemin d'un message.
CREATE INDEX IF NOT EXISTS idx_onboarding_interview_slack_user
  ON onboarding_interview (slack_user_id);
