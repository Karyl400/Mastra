-- ============================================================================
-- `employees.department` devient NULLABLE — 2026-08-13
-- ============================================================================
--
-- POURQUOI. Le parcours d'arrivée ne demande plus le département : la modale
-- « Compléter mon profil » ne pose qu'une seule question, le POSTE. Le
-- département n'est plus collecté nulle part, donc la colonne n'a plus de
-- valeur à recevoir.
--
-- POURQUOI UNE RECONSTRUCTION. SQLite n'a pas d'`ALTER COLUMN`. La seule voie
-- pour retirer un `NOT NULL` est de recréer la table, copier, supprimer,
-- renommer. Retenu contre une valeur sentinelle (`'unknown'`, `''`) : une
-- sentinelle dans une colonne NOT NULL finit toujours par être relue comme une
-- vraie valeur, et c'est le mode d'échec récurrent de ce dépôt —
-- `emailSent: false` sous `status: 'success'`, `documents.content` perdu en
-- silence, `status = Sent` posé avant le `try`, `evaluateResponse` fabriquant
-- des réponses. `NULL` est le seul encodage honnête de « on a délibérément
-- cessé de collecter ça ».
--
-- ⚠️ ORDRE IMPOSÉ : appliquer CE FICHIER **avant** de déployer le code qui
-- cesse de renseigner la colonne. L'inverse échouerait sur la contrainte
-- NOT NULL — même piège documenté pour `ddl-documents-content.sql`, à
-- l'envers.
--
-- `idx_employees_department` n'est PAS recréé : une colonne qu'on ne renseigne
-- plus n'a aucune raison d'être indexée. C'est une suppression délibérée, pas
-- un oubli de recopie.
--
-- REJOUABLE : la table reconstruite porte déjà la colonne nullable ; un second
-- passage recopie simplement les mêmes lignes.
--
-- Le `CHECK` sur l'email et tous les autres index sont RECOPIÉS à l'identique
-- depuis `schema.ts`. Une reconstruction qui en perdrait un les perdrait en
-- silence : SQLite ne signale jamais un index absent.
-- ============================================================================

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS employees_new;

CREATE TABLE employees_new (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  department TEXT,
  position TEXT NOT NULL,
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  onboarding_status TEXT NOT NULL DEFAULT 'not_started',
  manager_id TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  emergency_contact_relationship TEXT,
  salary_amount REAL,
  salary_currency TEXT DEFAULT 'EUR',
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  CONSTRAINT chk_employees_email CHECK (email LIKE '%@%')
);

INSERT INTO employees_new (
  id, first_name, last_name, email, phone, department, position, start_date,
  status, onboarding_status, manager_id, emergency_contact_name,
  emergency_contact_phone, emergency_contact_relationship, salary_amount,
  salary_currency, metadata, created_at, updated_at, deleted_at
)
SELECT
  id, first_name, last_name, email, phone, department, position, start_date,
  status, onboarding_status, manager_id, emergency_contact_name,
  emergency_contact_phone, emergency_contact_relationship, salary_amount,
  salary_currency, metadata, created_at, updated_at, deleted_at
FROM employees;

DROP TABLE employees;

ALTER TABLE employees_new RENAME TO employees;

CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email ON employees (email);
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees (status);
CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees (manager_id);
CREATE INDEX IF NOT EXISTS idx_employees_onboarding_status ON employees (onboarding_status);
CREATE INDEX IF NOT EXISTS idx_employees_start_date ON employees (start_date);
CREATE INDEX IF NOT EXISTS idx_employees_deleted_at ON employees (deleted_at);
CREATE INDEX IF NOT EXISTS idx_employees_name_search ON employees (first_name, last_name);

PRAGMA foreign_keys = ON;
