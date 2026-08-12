-- ============================================================================
-- slack_directory — annuaire des personnes du workspace (feature `directory`, P1)
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
-- Même chemin, donc, que `ddl-conversation-turns.sql`, `ddl-documents-content.sql` et
-- `ddl-slack-event-dedup.sql`.
--
-- ----------------------------------------------------------------------------
-- CE QU'IL REND POSSIBLE — l'AUTORISATION, qui n'existait pas
-- ----------------------------------------------------------------------------
-- `slack-events.handler.ts` lisait `event.user` pour le journal et l'anti-boucle, puis le
-- jetait. Une chaîne `U…` opaque : le système n'avait AUCUN moyen de dire si elle désignait la
-- responsable RH, un invité mono-canal ou un bot tiers. Conséquence, pas hypothèse : tous les
-- outils à effet de bord — `createEmployee`, `updateOnboardingStatus`, `generateDocument`,
-- `generateQuestionnaire`, `sendNotification`, `scheduleReminder` — étaient atteignables par
-- n'importe quel membre du workspace, invité externe compris.
--
-- Cette table est ce qui manquait pour que la question « qui parle ? » ait une réponse. Elle
-- porte des FAITS que Slack maintient lui-même (`is_bot`, `is_restricted`,
-- `is_ultra_restricted`, `deleted`, domaine de l'adresse), et non une liste d'identifiants
-- tenue à la main : ajouter un invité au workspace le rétrograde automatiquement, sans qu'aucune
-- variable d'environnement ne bouge. C'est l'exigence déjà appliquée à `agentToolBoundary(tools)`,
-- dérivée de `Object.keys(tools)` — ce dépôt a payé trois fois le prix d'une liste rédigée qui
-- se désynchronise du réel.
--
-- Elle sert aussi la question que trois agents posaient à l'utilisateur faute de savoir y
-- répondre : email → personne → `employee_id`.
--
-- ----------------------------------------------------------------------------
-- ⚠️ TANT QUE CETTE TABLE N'EXISTE PAS
-- ----------------------------------------------------------------------------
-- La synchronisation et la résolution du demandeur DÉGRADENT EN SILENCE : la requête lève,
-- l'appelant rattrape, aucun fait n'est connu sur personne — et **tout le monde continue d'être
-- traité exactement comme aujourd'hui, c'est-à-dire sans aucun contrôle**. La frontière
-- d'autorisation est alors présente dans le code et INOPÉRANTE en production, au mot près comme
-- l'était le correctif de la double réponse tant que `slack_event_dedup` manquait.
--
-- La ligne à chercher dans les logs est celle qui porte l'erreur brute de LibSQL, émise à
-- chaque résolution (texte vérifié le 2026-08-12 contre `@libsql/client`) :
--       SQLITE_ERROR: no such table: slack_directory
--
-- Drizzle l'enrobe de son propre préfixe, donc c'est sur `no such table` qu'il faut grepper :
--       Failed query: select "slack_user_id", "team_id", … from "slack_directory"
--
-- ----------------------------------------------------------------------------
-- APPLICATION
-- ----------------------------------------------------------------------------
--
--   Base locale :
--       sqlite3 data/kisso.db < scripts/ddl-slack-directory.sql
--
--   Turso / LibSQL distant (le blocage de `drizzle-kit push` ne concerne PAS le client turso) :
--       turso db shell <nom-de-la-base> < scripts/ddl-slack-directory.sql
--
--   Rejouable sans risque : `IF NOT EXISTS` partout, tables ET index — contrairement à
--   `ddl-documents-content.sql`, dont l'`ALTER TABLE … ADD COLUMN` n'a pas de forme idempotente.
--
--   ⚠️ ORDRE : `employees` doit exister avant, la clé étrangère la nomme. SQLite accepte
--   pourtant la création (les FK ne sont résolues qu'à l'usage, et seulement si
--   `PRAGMA foreign_keys = ON`) — sur une base neuve, appliquer le DDL des 10 tables d'abord.
--
--   Vérification (filtrer sur `tbl_name` et NON sur `name` : les index ne portent pas le
--   préfixe de la table, un `name LIKE 'slack_directory%'` les manquerait tous) :
--       SELECT type, name FROM sqlite_master WHERE tbl_name = 'slack_directory'
--        ORDER BY type DESC, name;
--       -- attendu : table slack_directory,
--       --           index idx_slack_directory_email,
--       --           index idx_slack_directory_employee_id,
--       --           index idx_slack_directory_synced_at
--       --           (+ sqlite_autoindex_slack_directory_1, créé par la PRIMARY KEY)
--
-- ----------------------------------------------------------------------------
-- NOTES DE CONCEPTION
-- ----------------------------------------------------------------------------
-- **La clé primaire est `slack_user_id`, PAS l'email.** Un email se change dans le profil
-- Slack ; l'identifiant `U…` est immuable pour la vie du compte. Faire porter la clé par
-- l'email ferait qu'un changement d'adresse créerait un SECOND sujet, avec ses propres droits
-- — donc une élévation de privilège par simple édition de profil.
--
-- **`email` est NULLABLE**, et ce n'est pas de la prudence de façade : `users.list` ne renvoie
-- `profile.email` que si `users:read.email` est accordé ET que le compte en porte un ; les bots
-- n'en ont pas. La politique traite « pas d'email » comme un cas NOMMÉ (`no_email`), jamais
-- comme une chaîne vide comparée à un domaine — une chaîne vide finirait par matcher.
--
-- **`dm_channel_id` NE PEUT PAS être découvert par balayage.** `conversations.list({types:'im'})`
-- répond `missing_scope` : il faudrait `im:read`, qui n'est pas accordé (vérifié le 2026-08-12).
-- La colonne se remplit donc OPPORTUNÉMENT, au premier DM reçu de la personne — Slack y livre
-- le canal gratuitement dans `event.channel`. Une colonne vide signifie « cette personne ne
-- nous a jamais écrit en direct », et non « nous ne savons pas le trouver ». Corollaire opératoire :
-- une valeur perdue est perdue DÉFINITIVEMENT, d'où le `set` champ-par-champ de l'upsert côté
-- repository, qui ne la nomme jamais.
--
-- **`real_name` / `display_name` : NOT NULL avec DEFAULT ''.** Un nom absent est une chaîne
-- vide, pas un NULL : ces champs sont affichés et concaténés, et un NULL y produirait un
-- « null » imprimé plutôt qu'un blanc. C'est l'inverse de l'arbitrage retenu pour `email`, qui
-- est une CLÉ de recherche — une chaîne vide y serait un faux positif.
--
-- **Les cinq flags de confiance sont `integer` NOT NULL DEFAULT 0** (Drizzle
-- `mode: 'boolean'`, qui lit et écrit 0/1). Aucun n'est nullable : « on ne sait pas si c'est un
-- invité » ne doit pas exister comme état — la politique d'autorisation devrait alors décider
-- sur un troisième cas, et le défaut sûr (`false`) y serait indiscernable de l'ignorance.
--
-- **L'index sur `email` est NON UNIQUE, à dessein.** Deux comptes peuvent porter la même adresse
-- le temps d'une migration ; une contrainte d'unicité ferait alors ÉCHOUER la synchronisation
-- ENTIÈRE plutôt que de rapporter deux lignes. `findByEmail` rend la première — ce port répond
-- à « qui est-ce ? », il n'arbitre pas les doublons.
--
-- **`employee_id` est le pont vers le métier**, et il est NULLABLE dans les deux sens : tout
-- membre du workspace n'est pas un employé enregistré, et tout employé enregistré n'a pas
-- forcément de compte Slack. La clé étrangère vers `employees(id)` est déclarée pour dire
-- l'intention ; elle n'est réellement contrainte que si `PRAGMA foreign_keys = ON`, ce qui n'est
-- le cas ni par défaut en SQLite ni systématiquement sur Turso.
--
-- **`first_seen_at` / `synced_at` en INTEGER (millisecondes, Drizzle `mode: 'timestamp_ms'`)**
-- et non en TEXT `datetime('now')` comme les 10 tables historiques — même écart assumé que
-- `conversation_turns` et `slack_event_dedup`. `synced_at` gouverne la fraîcheur (« Slack a-t-il
-- confirmé ces faits récemment ? ») et est indexé pour la resynchronisation ciblée ;
-- `first_seen_at` n'est écrit qu'à l'INSERT, une seule fois dans la vie de la ligne.
-- ============================================================================

CREATE TABLE IF NOT EXISTS slack_directory (
    slack_user_id       text    PRIMARY KEY NOT NULL,
    team_id             text    NOT NULL,

    email               text,                        -- null = bot, ou scope insuffisant
    real_name           text    NOT NULL DEFAULT '',
    display_name        text    NOT NULL DEFAULT '',

    -- Flags de CONFIANCE (0/1) — matière première de la politique d'autorisation.
    -- is_restricted = invité multi-canal ; is_ultra_restricted = invité mono-canal.
    is_bot              integer NOT NULL DEFAULT 0,
    is_admin            integer NOT NULL DEFAULT 0,
    is_restricted       integer NOT NULL DEFAULT 0,
    is_ultra_restricted integer NOT NULL DEFAULT 0,
    is_deleted          integer NOT NULL DEFAULT 0,

    -- Canal `D…`, appris au premier DM reçu : indécouvrable autrement (voir l'en-tête).
    dm_channel_id       text,

    -- Pont vers le métier, quand la personne est un employé enregistré.
    employee_id         text REFERENCES employees(id),

    first_seen_at       integer NOT NULL,
    synced_at           integer NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_slack_directory_email
    ON slack_directory (email);

CREATE INDEX IF NOT EXISTS idx_slack_directory_employee_id
    ON slack_directory (employee_id);

CREATE INDEX IF NOT EXISTS idx_slack_directory_synced_at
    ON slack_directory (synced_at);
