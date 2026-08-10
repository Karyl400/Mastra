# Configuration du Bot Slack pour Kisso Onboarding

## Instructions de Configuration

### 1. Créer une Slack App

1. Allez sur https://api.slack.com/apps
2. Cliquez sur "Create New App"
3. Choisissez "From scratch"
4. Nommez l'app "Kisso Onboarding Bot"
5. Sélectionnez votre workspace Slack

### 2. Configuration des Permissions (OAuth & Permissions)

Sous "OAuth & Permissions", ajoutez les scopes Bot Token:

**Bot Token Scopes:**
- `chat:write` - Pour envoyer des messages
- `channels:join` - Pour rejoindre des canaux
- `channels:read` - Pour lire les canaux
- `groups:read` - Pour lire les groupes privés
- `im:write` - Pour envoyer des messages directs
- `im:read` - Pour lire les messages directs
- `users:read` - Pour lire les informations utilisateur
- `users:read.email` - Pour accéder aux emails utilisateurs

### 3. Configuration des Events

Sous "Event Subscriptions":

> ### ⚠️ Deux pièges qui empêchent le bot de répondre
>
> **1. Socket Mode doit être DÉSACTIVÉ.**
> Socket Mode et la Request URL HTTP sont **mutuellement exclusifs**. Tant que Socket Mode est
> activé, Slack ouvre un WebSocket et **n'envoie aucune requête HTTP** vers la Request URL —
> l'écran affiche d'ailleurs « Socket Mode is enabled. You won't need to specify a Request URL ».
> La vérification du challenge échouera donc quoi qu'il arrive, même avec un endpoint parfaitement
> fonctionnel. → *Settings → Socket Mode → désactiver*, puis revenir vérifier la Request URL.
>
> **2. `app_mention` doit être ajouté aux bot events.**
> Le handler ne traite les mentions en canal **que** via `app_mention`, et n'accepte les événements
> `message` que lorsque `channel_type === 'im'` (DM). C'est volontaire : mentionner le bot dans un
> canal déclenche À LA FOIS `app_mention` et `message`, et n'en accepter qu'un seul est ce qui
> empêche une double réponse. Sans `app_mention` abonné, **les mentions en canal ne font rien**.

**Enable Events:**
1. Vérifiez que **Socket Mode est désactivé** (voir encadré ci-dessus).
2. Activez "Events"
3. Sous "Subscribe to bot events", ajoutez:
   - `app_mention` - **REQUIS** — mentions `@bot` dans un canal (ajoute le scope `app_mentions:read`)
   - `message.im` - **REQUIS** — messages directs (DM)
   - `message.channels` / `message.groups` - facultatifs : le handler les ignore
     (`reason: not_a_dm`), ils ne servent qu'à d'éventuels usages futurs.

**Request URL:**
- Ajoutez l'URL: `https://votre-domaine.com/slack/events`
- Slack enverra un challenge de vérification, **signé** — l'endpoint le vérifie avant de répondre.
  Si `SLACK_SIGNING_SECRET` diffère entre Slack et le déploiement, la réponse sera `401` et Slack
  affichera « Your URL didn't respond with the value of the challenge parameter ».

### 4. Installation du Bot

1. Sous "Basic Information", notez le "Signing Secret"
2. Ajoutez ces variables d'environnement:
   ```env
   SLACK_BOT_TOKEN=xoxb-votre-bot-token
   SLACK_SIGNING_SECRET=votre-signing-secret
   ```
3. Sous "Install App", installez le bot dans votre workspace

### 5. Inviter le Bot dans les Canaux

1. Allez dans le canal où vous voulez utiliser le bot
2. Tapez `/invite @Kisso Onboarding Bot`
3. Le bot peut maintenant recevoir et répondre aux messages

## Fonctionnement du Routing

Le bot route automatiquement les messages vers le bon agent selon les mots-clés:

**Onboarding Orchestrator (défaut):**
- Création d'employés
- Suivi d'onboarding
- Génération de documents
- Tâches générales

**Questionnaire Engine:**
- Mots-clés: "questionnaire", "évaluation", "quiz", "test"
- Génération de questionnaires
- Évaluation des réponses

**Notification Agent:**
- Mots-clés: "notification", "rappel", "email", "message"
- Envoi de notifications
- Planification de rappels
- Historique des communications

## Exemples d'Utilisation

```
# Sur Slack dans un canal où le bot est présent:

# Créer un employé
@Kisso Onboarding Bot Créer un employé nommé Jean Dupont, email jean@example.com, département Engineering

# Générer un questionnaire
@Kisso Onboarding Bot Génère un questionnaire d'évaluation culturelle

# Envoyer une notification
@Kisso Onboarding Bot Envoie un rappel à jean@example.com pour compléter son onboarding

# Question sur l'onboarding
@Kisso Onboarding Bot Quel est le statut de l'onboarding de jean@example.com?
```

## Variables d'Environnement Requises

> Placeholders uniquement. **Ne jamais committer de valeur réelle** ni la logger.
> Liste de référence complète : `.env.example`.

```env
# ── Slack ────────────────────────────────────────────────────────────────
SLACK_BOT_TOKEN=xoxb-...            # OAuth & Permissions → Bot User OAuth Token
SLACK_SIGNING_SECRET=...            # Basic Information → Signing Secret

# ── LLM (les agents ne démarrent pas sans) ───────────────────────────────
GROQ_API_KEY=...                    # primaire — llama-3.3-70b-versatile
MISTRAL_API_KEY=...                 # fallback — mistral-large-latest

# ── Base de données (LibSQL / Turso) ─────────────────────────────────────
DATABASE_URL=libsql://[db]-[org].turso.io
DATABASE_AUTH_TOKEN=...

# ── Email ────────────────────────────────────────────────────────────────
# SMTP est prioritaire : dès que SMTP_HOST + SMTP_USER + SMTP_PASS sont tous
# renseignés, `createEmailProvider()` (src/mastra/index.ts) choisit SmtpAdapter ;
# sinon il retombe sur BrevoAdapter. Voir docs/adr/006-fournisseur-email-smtp.md.
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=...@gmail.com
SMTP_PASS=...                       # Gmail : mot de passe d'APPLICATION (16 car.), 2FA requise
NOTIFICATION_FROM=...@gmail.com     # doit correspondre à un expéditeur autorisé par le serveur SMTP
BREVO_API_KEY=...                   # fallback uniquement — compte transactionnel non activé (403)

# ── Application ──────────────────────────────────────────────────────────
LOG_LEVEL=info                      # debug | info | warn | error
NODE_ENV=production                 # development | staging | production | test
```

En déploiement Vercel, ces variables doivent être définies dans *Project Settings →
Environment Variables* **et** le projet redéployé : Vercel n'injecte les nouvelles
valeurs qu'au build suivant.

## Déploiement

Après avoir configuré le bot Slack:

1. Déployez votre application Mastra
2. Assurez-vous que l'endpoint `/slack/events` est accessible publiquement
3. Mettez à jour l'URL Request URL dans la configuration Slack avec votre domaine de production
4. Testez en envoyant un message dans un canal Slack

## Dépannage

**Le bot ne répond pas (aucune requête n'arrive au serveur) :**
- **Socket Mode activé** — cause n°1, voir l'encadré §3. Slack n'envoie rien en HTTP.
- **`app_mention` non abonné** — cause n°2 : les mentions en canal ne déclenchent rien.
- Le bot n'est pas invité dans le canal (`/invite @mastra`).
- La Request URL n'affiche pas « Verified » côté Slack.

**Le bot ACK mais ne répond jamais (serverless freeze) :**
Symptôme : les logs montrent le `200` renvoyé en < 3 s, aucune erreur, mais aucun message
ne revient dans Slack. Cause probable : le handler ACK immédiatement puis traite l'agent
**en tâche de fond**, or une fonction serverless (Vercel) peut être **gelée dès la réponse
HTTP envoyée** — l'appel LLM en vol est tué au milieu, silencieusement.
- Diagnostic : chercher dans les logs la ligne de démarrage du traitement d'agent sans la
  ligne de fin correspondante. Comparer avec un run local (`npm run dev`), où le processus
  ne gèle pas : si ça marche en local et pas en prod, c'est ça.
- Contournement immédiat : rien de fiable — c'est une propriété de la plateforme.
- Correctif durable : sortir le traitement de la requête HTTP vers une file durable
  (`inngest` est déjà une dépendance du projet) et laisser le worker répondre à Slack via
  `chat.postMessage`.

**Réponse `401` de l'endpoint :**
- `missing_signature_headers` : la requête n'a pas `X-Slack-Signature` /
  `X-Slack-Request-Timestamp` — ce n'est pas Slack qui appelle (curl, health check…).
- Signature invalide : `SLACK_SIGNING_SECRET` diverge entre l'app Slack et le déploiement.
  Après une régénération du secret côté Slack, **redéployer**.
- Timestamp hors fenêtre : rejet au-delà de 5 minutes (anti-rejeu). Horloge de la machine
  désynchronisée, ou requête rejouée à la main depuis un vieux payload.

**Erreur de vérification URL (challenge) :**
- Vérifiez que l'application est en ligne et que l'endpoint est bien **`/slack/events`**.
- **Le préfixe `/api` est réservé** : `@mastra/server` refuse au **démarrage** toute route
  personnalisée commençant par `/api`. Une app qui ne boote pas ne répond à rien.
- Une route n'existe que si elle est déclarée dans `server.apiRoutes` de
  `src/mastra/index.ts` via `registerApiRoute()`. Un fichier posé dans `src/api/` n'est
  **jamais** monté automatiquement.

**Le bot répond deux fois :**
- `app_mention` **et** `message` traités tous les deux. Le handler ne doit accepter
  `message` que si `channel_type === 'im'`.

**Le même message est traité plusieurs fois :**
- Slack rejoue un événement quand l'ACK dépasse 3 s (`X-Slack-Retry-Num`). La déduplication
  se fait sur `event_id` via un cache LRU **en mémoire, donc par instance** : avec plusieurs
  instances serverless concurrentes, la dédup ne tient pas. Correctif : dédup partagée
  (base ou cache externe).

**Aucun email envoyé alors que le workflow retourne `status: 'success'` :**
- L'échec d'email est **silencieux** : `sendWelcomeEmail` avale l'erreur et pose
  `emailSent: false`. Toujours vérifier `emailSent`, jamais `status`.
  Voir `docs/adr/006-fournisseur-email-smtp.md`.

**Mauvais routing d'agent :**
- Vérifiez les mots-clés dans le message.
- Consultez les logs pour voir quel agent a été sélectionné.
