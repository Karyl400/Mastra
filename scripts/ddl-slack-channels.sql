-- ============================================================================
-- slack_channels / slack_channel_members — INVENTAIRE des canaux (feature `directory`)
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
-- Même chemin, donc, que `ddl-conversation-turns.sql`, `ddl-slack-event-dedup.sql` et
-- `ddl-slack-directory.sql`.
--
-- ----------------------------------------------------------------------------
-- ⚠️⚠️ CES DEUX TABLES SONT UN INVENTAIRE D'OBSERVABILITÉ.
--      ELLES NE SONT JAMAIS, EN AUCUN CAS, UNE SOURCE D'AUTORISATION.
-- ----------------------------------------------------------------------------
-- Quelqu'un finira par ouvrir ce fichier en cherchant « qui a le droit de voir ce canal ». La
-- réponse est : PAS ICI. « Les membres de #engineer-karyl » RESSEMBLE à une liste
-- d'autorisation — c'est précisément ce qui rend l'erreur probable. `#engineer-karyl` est PRIVÉ,
-- et servir son contenu à un non-membre sur la foi de ces lignes est exactement le « deputy
-- confus » de `PLAN-ARCHITECTURE.md` §4.1, que la feature `knowledge` ferme en interrogeant
-- Slack EN DIRECT à chaque décision de divulgation.
--
-- L'aggravant est VÉRIFIÉ, pas supposé : **il n'existe aucun chemin d'invalidation**. Les
-- abonnements de l'app Slack sont `app_mention`, `message.im`, `message.channels`,
-- `message.groups` — ni `member_joined_channel`, ni `member_left_channel`. Aucun événement ne
-- viendra jamais démentir une ligne d'ici. Ces tables ne sont donc pas « périmées dans trois
-- jours » : elles sont fausses, et silencieuses, dès la première personne qui quitte un canal
-- entre deux synchronisations manuelles. Une donnée fausse et muette employée comme frontière
-- de sécurité est pire que pas de frontière — c'est la leçon d'`emailSent: false` sous
-- `status: 'success'`, transposée à l'autorisation.
--
-- La règle n'est pas seulement écrite, elle est EXÉCUTABLE :
-- `tests/unit/directory/channel-inventory-not-an-acl.test.ts` échoue si `knowledge/**`,
-- `access-policy.ts` ou `access-guard.ts` importent le repository de canaux.
--
-- Ce que ces tables servent, et rien d'autre : « dans quels canaux le bot est-il ? »,
-- « combien de personnes y a-t-il ? », « qui y est ? », « depuis quand ? ».
--
-- ----------------------------------------------------------------------------
-- ⚠️ TANT QUE CES TABLES N'EXISTENT PAS
-- ----------------------------------------------------------------------------
-- La synchronisation des canaux échoue BRUYAMMENT, canal par canal, et le rapport nomme
-- l'erreur brute de LibSQL :
--       SQLITE_ERROR: no such table: slack_channels
-- La couverture de canaux (`conversations.join`), elle, continue de fonctionner : l'inventaire
-- est une dépendance OPTIONNELLE du service.
--
-- ----------------------------------------------------------------------------
-- APPLICATION
-- ----------------------------------------------------------------------------
--
--   Recommandé (applique ET vérifie) :
--       npx tsx --env-file=.env scripts/apply-ddl.mts scripts/ddl-slack-channels.sql
--
--   Base locale :
--       sqlite3 data/kisso.db < scripts/ddl-slack-channels.sql
--
--   Rejouable sans risque : `IF NOT EXISTS` partout, tables ET index — contrairement à
--   `ddl-documents-content.sql`, dont l'`ALTER TABLE … ADD COLUMN` n'a pas de forme idempotente.
--
--   ⚠️ ORDRE INTERNE : `slack_channels` AVANT `slack_channel_members`, la clé étrangère la
--   nomme. Les énoncés ci-dessous sont déjà dans cet ordre.
--
--   Vérification (filtrer sur `tbl_name` et NON sur `name` : les index ne portent pas le
--   préfixe de leur table, un `name LIKE 'slack_channel%'` les manquerait tous) :
--       SELECT type, name FROM sqlite_master
--        WHERE tbl_name IN ('slack_channels', 'slack_channel_members')
--        ORDER BY tbl_name, type DESC, name;
--       -- attendu : table slack_channels,
--       --           index idx_slack_channels_synced_at,
--       --           table slack_channel_members,
--       --           index idx_slack_channel_members_user,
--       --           index idx_slack_channel_members_synced_at
--       --           (+ sqlite_autoindex_* créés par les PRIMARY KEY)
--
--   Contrôle de cohérence, après `npx tsx scripts/sync-slack-directory.mts --channels --apply` —
--   c'est LA requête qui rend le signal de fraîcheur lisible :
--       SELECT c.channel_id, c.name, c.is_member,
--              c.member_count_reported AS slack_dit,
--              COUNT(m.slack_user_id)  AS observe
--         FROM slack_channels c
--         LEFT JOIN slack_channel_members m ON m.channel_id = c.channel_id
--        GROUP BY c.channel_id
--        ORDER BY c.name;
--       -- relevé du 2026-08-12 : #alerts-dev 4, #kisso-hq 6, #random 5, #signals 5,
--       --                        #engineer-karyl 4 (privé), #engineering-chat 5.
--
-- ----------------------------------------------------------------------------
-- NOTES DE CONCEPTION
-- ----------------------------------------------------------------------------
-- **La clé primaire de `slack_channels` est `channel_id`, PAS le nom.** Un canal se renomme
-- (`#random` → `#random-fr`) sans que son `C…` bouge : une clé portée par le nom ferait qu'un
-- renommage crée un SECOND canal et laisse l'ancien vivre à côté, avec ses membres périmés.
-- Même arbitrage que `slack_directory`, dont la clé est le `U…` et non l'email.
--
-- **`member_count_reported` porte ce nom parce que c'est une ASSERTION DE SLACK**
-- (`conversations.list` → `num_members`), et NON un cache du `COUNT(*)` de la table de
-- jointure. Les deux viennent d'appels DISTINCTS, donc d'instants distincts, et divergent
-- normalement. Le vrai compte est `COUNT(*)` ; l'écart entre les deux est un signal de fraîcheur
-- GRATUIT sur une table qu'aucun événement ne dément. L'appeler `member_count` aurait garanti
-- qu'on le prenne un jour pour l'autorité, puis qu'on « corrige » l'écart en le réécrivant.
-- NULLABLE : Slack ne rend pas toujours `num_members` (canaux privés notamment), et NULL dit
-- « Slack n'a rien affirmé », ce qu'un `0` — indiscernable d'un canal vide — ne dirait pas.
--
-- **`slack_channel_members` a une PRIMARY KEY COMPOSITE `(channel_id, slack_user_id)`, sans
-- aucune clé de substitution.** La ligne n'a pas d'identité propre : elle EST l'appartenance. Un
-- `id` autogénéré autoriserait deux lignes identiques pour le même couple, et le doublon ne se
-- verrait qu'au `COUNT(*)` — c'est-à-dire dans le seul chiffre que cette table existe pour
-- rendre. C'est aussi cette PK qui rend le remplacement atomique par ligne
-- (`INSERT … ON CONFLICT DO UPDATE`).
--
-- **CLÉ ÉTRANGÈRE : sur `channel_id` OUI, sur `slack_user_id` NON.** L'arbitrage est le point
-- délicat de ce fichier, et `PRAGMA foreign_keys = 1` étant ACTIF sur la Turso de production
-- (vérifié le 2026-08-12), il a des conséquences réelles et immédiates.
--   • `channel_id → slack_channels(channel_id)` : les deux lignes sont écrites par la MÊME passe
--     de synchronisation, le canal AVANT ses membres. La contrainte est donc toujours
--     satisfaisable, et elle interdit une appartenance orpheline — une ligne qui ne désigne
--     aucun canal ne veut rien dire. Elle échoue bruyamment, ce qui est le comportement voulu.
--   • `slack_user_id` → **AUCUNE FK vers `slack_directory`**. Un membre de canal peut
--     parfaitement être un compte que l'annuaire ne connaît pas encore : les deux
--     synchronisations sont INDÉPENDANTES (`--members` et `--channels` s'exécutent séparément),
--     une personne arrivée depuis le dernier balayage de `users.list` n'a pas de ligne, et les
--     bots tiers n'en ont pas non plus. Avec le pragma actif, une FK ici ferait ÉCHOUER
--     l'enregistrement précisément sur les comptes les plus intéressants — les nouveaux
--     arrivants — et imposerait un ORDRE entre deux synchronisations qui n'en ont pas. Un
--     inventaire enregistre ce qu'il OBSERVE ; il n'est pas la vérité référentielle des
--     personnes.
--
-- **`first_seen_at` SURVIT aux resynchronisations d'une personne toujours présente.** C'est le
-- champ que `replaceMembers` ne nomme JAMAIS dans son `set`, exactement comme `upsertFacts`
-- protège `dm_channel_id`. Le mode d'échec évité est celui, déjà payé, de `documents.content` :
-- une écriture qui perd une donnée en silence.
--
-- **`synced_at` porte la sémantique de REMPLACEMENT.** Les membres d'un canal à l'instant T sont
-- un ENSEMBLE, pas une accumulation : la passe réécrit `synced_at` sur les membres présents,
-- puis supprime du canal tout ce qui porte encore un `synced_at` antérieur. Une personne partie
-- DISPARAÎT. D'où l'index sur cette colonne — c'est lui qui sert la suppression de fin de passe.
--
-- **Index sur `slack_user_id`** : la PK indexe `(channel_id, slack_user_id)` et ne sait donc pas
-- répondre à « dans quels canaux est cette personne ? ». Sans cet index, la question coûte un
-- balayage complet.
--
-- **Millisecondes en INTEGER (Drizzle `mode: 'timestamp_ms'`)** et non `datetime('now')` en TEXT
-- comme les 10 tables historiques — même écart assumé que `conversation_turns`,
-- `slack_event_dedup` et `slack_directory`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS slack_channels (
    channel_id            text    PRIMARY KEY NOT NULL,

    -- NOT NULL DEFAULT '' : le nom est affiché et concaténé, un NULL y imprimerait « null ».
    name                  text    NOT NULL DEFAULT '',

    -- Faits d'accès. `is_member` est le seul qui décide si `chat.postMessage` peut aboutir —
    -- c'est lui, et non « le bot est invité », qui produit ou non un `not_in_channel`.
    is_private            integer NOT NULL DEFAULT 0,
    is_archived           integer NOT NULL DEFAULT 0,
    is_member             integer NOT NULL DEFAULT 0,

    -- ⚠️ ASSERTION DE SLACK (`num_members`), pas un cache du COUNT(*). NULL = Slack n'a rien
    -- affirmé. Voir l'en-tête : l'écart avec le compte observé est le signal de fraîcheur.
    member_count_reported integer,

    synced_at             integer NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_slack_channels_synced_at
    ON slack_channels (synced_at);

CREATE TABLE IF NOT EXISTS slack_channel_members (
    -- FK DÉCLARÉE : le canal est écrit AVANT ses membres par la même passe, donc la contrainte
    -- est toujours satisfaisable, et une appartenance orpheline ne désignerait rien.
    channel_id    text    NOT NULL REFERENCES slack_channels(channel_id),

    -- ⚠️ AUCUNE FK vers `slack_directory` : un membre de canal peut être un compte que
    -- l'annuaire ne connaît pas encore (nouvel arrivant, bot tiers). Voir l'en-tête.
    slack_user_id text    NOT NULL,

    -- SURVIT aux resynchronisations : jamais réécrit pour une personne toujours présente.
    first_seen_at integer NOT NULL,

    -- Marqueur de passe : porte la sémantique de remplacement (voir l'en-tête).
    synced_at     integer NOT NULL,

    -- PK COMPOSITE, sans clé de substitution : la ligne EST l'appartenance.
    PRIMARY KEY (channel_id, slack_user_id)
);

-- « Dans quels canaux est cette personne ? » — la PK n'indexe pas dans ce sens.
CREATE INDEX IF NOT EXISTS idx_slack_channel_members_user
    ON slack_channel_members (slack_user_id);

-- Détection des départs : colonne sur laquelle porte la suppression de fin de passe.
CREATE INDEX IF NOT EXISTS idx_slack_channel_members_synced_at
    ON slack_channel_members (synced_at);
