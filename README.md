# Kisso Onboarding

Bot Slack d'intégration des nouveaux employés pour **Kisso Industries**. Quatre agents LLM
orchestrent la création du dossier, la production de documents, les notifications et la
préparation d'entretiens de recrutement — le tout depuis une conversation Slack.

Il n'y a **aucun frontend** : Slack est l'unique interface. Le service est une fonction
serverless déployée sur Vercel.

---

## Démarrage rapide

```bash
git clone <url-du-dépôt> && cd mastra
npm ci
cp .env.example .env      # puis renseigner les variables (voir plus bas)
npm run db:init           # crée data/kisso.db à partir du schéma Drizzle
npm run dev               # serveur local + playground Mastra
```

**Prérequis** — Node.js `>=22.13.0` (déclaré dans `engines`), `sqlite3` en ligne de commande
pour `db:init`, et un compte Turso pour la base distante.

Vérifier une installation :

```bash
npm run typecheck && npm run test:unit && npm run lint
```

Les trois doivent être muets. `lint` n'est **pas** suffixé de `|| true` : une erreur y fait
échouer la CI.

---

## Variables d'environnement

Il n'existe **aucune validation centralisée** : chaque module lit `process.env` à son point
d'usage. Seule `DATABASE_URL` fait échouer le démarrage si elle manque ; les autres dégradent
silencieusement, ce qui est un défaut connu et suivi.

| Variable | Rôle | Sans elle |
| --- | --- | --- |
| `DATABASE_URL` | LibSQL / Turso | **Le démarrage échoue** |
| `DATABASE_AUTH_TOKEN` | Jeton Turso | Base distante inaccessible |
| `GROQ_API_KEY` | Modèle primaire (`openai/gpt-oss-120b`) | Chaîne construite mais morte |
| `MISTRAL_API_KEY` | Modèle de repli (`mistral-large-latest`) | Maillon omis de la chaîne |
| `SLACK_BOT_TOKEN` | `xoxb-…`, client Web + envois | Aucun message ne part |
| `SLACK_SIGNING_SECRET` | Vérification HMAC des événements | **Tout est refusé en 401** |
| `MASTRA_API_TOKEN` | Bearer des routes `/api/*` | Les routes refusent tout |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Envoi email primaire | Repli sur Brevo |
| `BREVO_API_KEY` | Envoi email de repli | Aucun transport email |
| `NOTIFICATION_FROM` | Expéditeur des emails | — |
| `AUTHZ_ENFORCE` | `true` applique la frontière d'autorisation | Décision calculée, jamais appliquée |
| `ONBOARDING_WELCOME_CHANNELS` | Canaux d'accueil, séparés par des virgules | Aucune invitation, et la phrase disparaît du message |
| `RECRUITMENT_TIMEZONE` / `DISPLAY_TIMEZONE` | Fuseau d'affichage | Défaut `Africa/Lagos` |
| `LOG_LEVEL` / `NODE_ENV` | `debug\|info\|warn\|error`, `development\|production\|test` | Défauts raisonnables |

**Gmail exige un mot de passe d'application** de 16 caractères, jamais le mot de passe du
compte. Ne jamais journaliser la valeur d'une clé — uniquement sa présence.

---

## Arborescence

Architecture par feature (*screaming architecture*). Chaque contexte métier vit sous
`src/features/<nom>/` et suit les mêmes trois couches.

```
src/
├── features/            8 contextes métier, tous bâtis sur le même moule
│   ├── conversation/      mémoire conversationnelle : fenêtrage en tokens, TTL 60 min
│   ├── directory/         annuaire Slack et frontière d'autorisation
│   ├── document/          rendu PDF/DOCX depuis un modèle logique unique
│   ├── employee/          dossiers employés, recherche par nom et par email
│   ├── knowledge/         lecture de canaux, sélection d'extraits par saillance
│   ├── notification/      email et Slack, routage des événements, limitation de débit
│   ├── onboarding/        parcours d'accueil, entretien, email de bienvenue
│   └── recruitment/       préparation d'un email d'entretien candidat
│
├── shared/              transverse — sans dépendance vers aucune feature
│   ├── security/          garde-fou anti-injection, filtres de sortie, gardes d'API
│   ├── llm/               chaîne Groq → Mistral, borne de durée
│   └── …                  logger, erreurs, contexte de requête Slack, court-circuits
│
├── infrastructure/      connexion base (Drizzle + LibSQL), schéma, journal d'audit
├── api/                 routes HTTP : événements Slack, interactivité
└── mastra/index.ts      LE point de câblage — agents, outils, routes, middlewares
```

Chaque feature se décompose ainsi :

```
features/<nom>/
├── domain/              TypeScript pur, ZÉRO import de framework
│   ├── entities/          objets métier
│   ├── value-objects/     valeurs sans identité
│   ├── services/          règles pures, testables sans aucune E/S
│   └── ports/             interfaces des dépôts et services externes
├── application/         ce que Mastra consomme
│   ├── agents/            makeXxx(tools) => new Agent({…})
│   ├── tools/             makeXxx(deps)  => createTool({…})
│   ├── workflows/         orchestrations multi-étapes
│   ├── dtos/ · mappers/   projections vers l'extérieur
└── infrastructure/      implémentations des ports
    ├── repositories/      drizzle-*.repository.ts + in-memory-* pour les tests
    ├── providers/         adaptateurs externes (Slack, SMTP, Brevo)
    ├── services/          services techniques
    └── handlers/          entrées événementielles
```

**Règle de dépendance** — `domain` ne dépend de rien ; `application` dépend de `domain` ;
`infrastructure` implémente les ports du `domain`. Jamais l'inverse.
`tests/unit/quality/architecture.test.ts` la vérifie sur `domain/` et `application/`.

Autres répertoires :

| Chemin | Contenu |
| --- | --- |
| `tests/unit/` | Miroir de `src/`. Les dépôts `in-memory-*` servent de doublure — ne jamais mocker Drizzle à la main |
| `tests/integration/` | Tests touchant de vrais fournisseurs. **Non lancés par la CI** : ils consomment du quota |
| `docs/conception/` | Les décisions de conception, une page par feature |
| `docs/adr/` | Décisions d'architecture. On n'en modifie jamais une : on en crée une nouvelle |
| `scripts/` | Outillage d'exploitation. Hors `typecheck` et hors `lint` |
| `drizzle/` | Migrations générées. **Désynchronisées du schéma** — voir `docs/conception/plateforme.md` |
| `public/` | Actifs statiques servis par le CDN, jamais par la fonction |

---

## Commandes

### Développement

| Commande | Effet |
| --- | --- |
| `npm run dev` | Serveur local et playground Mastra |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint sur `src/`. Zéro warning est un invariant |
| `npm run format` | Prettier sur tout le dépôt |

### Tests

| Commande | Effet |
| --- | --- |
| `npm run test:unit` | ~1 950 tests, ~40 s. **À lancer après chaque modification** |
| `npm run test:coverage` | Couverture. `tests/unit/infrastructure/**` en est exclu |
| `npm run test:integration` | ⚠️ Appels réels aux fournisseurs, consomme du quota |

### Base de données

| Commande | Effet |
| --- | --- |
| `npm run db:init` | DDL du schéma → `data/kisso.db` |
| `npm run db:generate` | Génère une migration. Exige un vrai TTY |
| `npm run db:ddl` | Applique un fichier DDL sur la base distante |

`npm run db:push` **se bloque** sans erreur contre une base `libsql://` distante : ne pas
l'utiliser en production.

### Exploitation

| Commande | Effet |
| --- | --- |
| `npm run probe:authz` | Qui perdrait quoi si `AUTHZ_ENFORCE` était posé. **Lecture seule** |
| `npm run role:set` | Inventaire des rôles ; `-- --email <x> --apply` pour désigner un manager |
| `npm run directory:show` | État de l'annuaire Slack |
| `npm run directory:sync` | Synchronise l'annuaire. Dry-run par défaut |
| `npm run profile:invite` | Invite au formulaire de profil. Dry-run par défaut |
| `npm run probe:replies` | Vérifie les court-circuits déterministes. Ne dépense aucun token |

**Trois commandes agissent réellement** et ne sont pas des simulations :
`npm run smoke:email` **envoie un vrai email**, `npm run probe:erasure` **supprime réellement**
des données, et `npm run directory:prune -- --apply` retire des lignes.

---

## Déploiement

Vercel, via `@mastra/deployer-vercel`.

```bash
npm run build:prod        # typecheck + build + élagage + vérification du bundle
npx vercel --prod
```

`build:prod` enchaîne quatre étapes, et chacune peut faire échouer le déploiement :

1. `tsc --noEmit` — aucune erreur de type ne part en production ;
2. `mastra build` — produit `.vercel/output` ;
3. `scripts/fix-vercel-output.js` — élague le bundle **par atteignabilité** : le graphe des
   imports est calculé depuis les modules racines et tout paquet inatteignable est supprimé.
   La liste n'est jamais écrite à la main, elle est calculée ;
4. `npm run verify:bundle` — **importe réellement** `index.mjs`, produit un vrai PDF et un
   vrai DOCX depuis le bundle. C'est le seul contrôle qui distingue une liaison ESM rompue
   d'un pair non satisfait inoffensif.

### Deux fonctions, pas une

| Fonction | Rôle | Dépendances |
| --- | --- | --- |
| `index` | L'application complète | ~160 Mo |
| `slack-ack` | Portier d'accusé de réception | **aucune** (~8 Ko) |

Slack exige une réponse en moins de 3 secondes. Le portier vérifie la signature HMAC, répond,
puis réexpédie la requête inchangée vers `/internal/slack/…`, où la route applicative la
retraite — même handler, même vérification de signature. Le chemin distinct existe pour que
le routage Vercel ne renvoie pas la requête réexpédiée au portier, ce qui serait une boucle.

Ce n'est pas une porte dérobée : les routes internes vérifient la même signature, et un POST
non signé y reçoit un 401.

### Configuration Slack

L'URL à déclarer dans *Event Subscriptions* est `https://<domaine>/slack/events` — **pas**
`/api/slack-events` : le préfixe `/api` est réservé par `@mastra/server`, et une route
personnalisée qui commence par lui fait échouer le **démarrage**.

Trois réglages non évidents, chacun ayant déjà rendu le bot muet :

- **Socket Mode doit être désactivé** — il est exclusif de la Request URL HTTP ;
- **`features.app_home.messages_tab_enabled` doit être à `true`** — ce réglage vit dans *App
  Home*, pas dans *Event Subscriptions*, et sans lui aucun `message.im` n'est jamais émis ;
- **Après tout changement de scope, réinstaller l'app** — l'ajout seul ne propage rien.

---

## Contribuer

1. Lire l'intégralité d'un fichier avant de le modifier.
2. TDD : test rouge, puis vert, puis refactor.
3. `npm run typecheck && npm run test:unit && npm run lint` vert avant chaque commit.
4. Ne jamais modifier un ADR existant — en créer un nouveau.
5. Documentation en français, **code et identifiants en anglais**.

Les décisions de conception ne vivent pas dans le code : elles sont dans
[`docs/conception/`](docs/conception/), une page par feature, chaque entrée renvoyant au
fichier et à la ligne concernés.

---

## Pile technique

| Élément | Valeur |
| --- | --- |
| Runtime | Node.js `>=22.13.0`, ESM |
| Langage | TypeScript `6.0.3`, mode strict |
| Framework | Mastra `@mastra/core` `1.57.x` |
| Modèles | Groq `openai/gpt-oss-120b` → repli Mistral `mistral-large-latest` |
| Base | Turso / LibSQL + Drizzle ORM `0.45.x` |
| Validation | Zod `3.25.76` — **version épinglée**, le parseur du SDK casse au-delà |
| Tests | Vitest `4.1.10` |
| Slack | `@slack/web-api` `8.x` |
| Email | `nodemailer` (primaire), `@getbrevo/brevo` (repli) |
| Documents | `pdfmake` `0.3` et `docx` `9.7.1` |
| Déploiement | Vercel |
