# Mémoire conversationnelle, routage collant et garde-fous — conception

Date : 2026-08-11
Statut : validé par l'utilisateur, en cours d'implémentation

## Problème

Campagne Slack du 2026-08-11 (DM avec `@mastra`, 2:55 → 3:07). Le bot :

1. redemande un email donné une minute plus tôt, et **fabrique** `votre_email@example.com` ;
2. change d'agent en plein échange — « Par email » répond à une question que le nouvel agent
   n'a jamais posée ;
3. annonce un PDF et livre un lien `https://kisso.internal/docs/<uuid>/download` qui n'existe
   nulle part dans le dépôt ;
4. se contredit (« je n'ai pas le droit d'envoyer des emails » alors que `sendNotification`
   est exposé à `notificationAgent`) ;
5. poste **deux** messages pour un seul message utilisateur, dont « Désolé, une erreur s'est
   produite ».

## Diagnostic établi (code, pas hypothèse)

### Absence totale de mémoire

`slack-events.handler.ts:755` → `agent.generate(safeInput)` : une chaîne nue, sans `threadId`,
sans `resourceId`, sans `memory`. `grep "@mastra/memory|new Memory|threadId"` sur `src/` → 0
occurrence utile. Le `thread_ts` Slack est calculé ligne 730 mais ne sert qu'à placer la réponse.
**Chaque message est un tour n°1 absolu.**

### Le routage aggrave le défaut

`routeToAgent` est recalculé par message, sur le texte seul. Rejeu des textes réels :

| Heure | Texte | Agent atteint | Déclencheur |
|---|---|---|---|
| 2:55 | `Email: …` | notificationAgent | `email` |
| 2:56 | `As-tu envoyé le rapport ?` | onboardingOrchestrator | défaut |
| 2:57 | `Par email` | notificationAgent | `email` |
| 3:00 | `Donne le PDF alors` | onboardingOrchestrator | défaut (`pdf` n'est dans aucune liste) |

Le fil alterne **A → B → A → B → A**. Chaque bascule est un redémarrage complet.
La mémoire seule ne corrigerait donc rien : chaque agent aurait sa propre continuité.

### Le budget de tokens commande le design

Modèle recalibré contre les mesures de prod du 2026-08-08 (écart **0,5 %** sur
`questionnaireEngine` et `notificationAgent`).

**Le préfixe est repayé intégralement à chaque aller-retour** : un run de K étapes coûte
`K × FLOOR`. Donc **chaque token de mémoire est facturé K fois**.

Budget disponible pour l'historique, sous le plafond Groq de 12 000 tok/min :

| Agent | K=1 | K=2 | K=3 | K=4 |
|---|---:|---:|---:|---:|
| `onboardingOrchestrator` | 9 713 | 3 483 | **1 253** | 23 |
| `notificationAgent` | 9 971 | 3 741 | 1 511 | 281 |
| `questionnaireEngine` | 10 096 | 3 866 | 1 636 | 406 |

En mémoire brute (tool-calls + tool-results), le plafond explose dès **N=3 messages**. Un seul
retour de `getEmployeeProfile` pèse **979 tokens** — plus que six messages de texte.

### Hallucinations = trous fonctionnels

- `grep kisso.internal` sur tout le dépôt → **0 occurrence**. Pure invention.
- Aucun outil exposé ne retourne d'URL : l'entité `Document` n'a ni `url` ni `path`.
- Aucun agent ne peut produire un PDF : `PdfmakeService` n'est câblé que dans
  `documentGenerationWorkflow`, hors de portée des agents.
- Les blocs « RÈGLE ANTI-INVENTION » listent « prénom, nom, email, date, score » — **pas
  « URL »**.
- `votre_email@example.com` : le modèle fabrique une valeur syntaxiquement valide pour
  satisfaire le schéma Zod de `findEmployeeByEmail`. Même mécanisme que celui déjà documenté
  pour `createEmployee` (`src/mastra/index.ts:133-139`).

## Décisions

### D1 — Clé de conversation

```
conversationId = threadTs ? `${channel}:${threadTs}` : channel
```

En DM `threadTs` est `undefined` **par conception** (ligne 727 : threader un DM avait rendu le
bot silencieux) → le canal `D…` est la conversation. En canal, `thread_ts ?? ts` → un thread est
une conversation.

**TTL unique de 60 minutes d'inactivité** gouvernant mémoire, collance et rétention. Un seul
paramètre plutôt que trois qui divergeront.

### D2 — Feature `conversation`, sans `@mastra/memory`

`@mastra/memory@1.26.0` est compatible avec core 1.57 mais dépend de `zod ^4.4.3`, alors que le
projet épingle `zod 3.25.76` précisément parce que le parseur du Vercel AI SDK casse. Surtout,
il ne sait plafonner qu'en **nombre de messages** — inadapté à un tool-result de 979 tokens.

```
src/features/conversation/
├── domain/
│   ├── entities/conversation-turn.ts
│   ├── value-objects/conversation-id.ts
│   ├── services/token-window.ts
│   └── ports/conversation.repository.ts
└── infrastructure/repositories/
    ├── drizzle-conversation.repository.ts
    └── in-memory-conversation.repository.ts
```

Une seule table `conversation_turns`, index `(conversation_id, created_at)`. L'agent collant est
l'`agent_id` du dernier tour — la requête de fenêtre le ramène déjà, pas de seconde table.

### D3 — Fenêtre en tokens, jamais en messages

- estimation `ceil(content.length / 3.5)`, ratio calibré sur les mesures du projet ;
- **on ne coupe jamais une paire user/assistant** : un assistant orphelin répondrait à une
  question invisible ;
- un tour dépassant 40 % du budget est tronqué — sinon un message géant avale la fenêtre ;
- retour en ordre chronologique.

**On ne stocke que le texte.** Jamais de tool-call, jamais de tool-result : levier à −63 %, gratuit.

### D4 — Sécurité de la mémoire

`validateDelimiterIntegrity` (`llm-guardrail.ts:556`) **rejette toute seconde balise ouvrante**.
Donc `history.map(wrapAgentInput).join()` lèverait `SecurityBlockError` sur chaque message.

1. L'historique voyage en **messages structurés**, non encadrés — le rôle porte la hiérarchie.
   Un **seul** bloc `<kisso_XXXX_user_input>`, sur le message courant, conforme aux
   DIRECTIVE 3.1/3.2 qui annoncent le bloc « appended below this prompt ».
2. **On n'écrit en mémoire qu'un tour ayant passé `wrapAgentInput` sans lever.** Un message
   bloqué pour injection n'entre jamais en mémoire, donc ne se rejoue jamais.
3. Le tour `assistant` est stocké **après `sanitizeAgentOutput`**. Sinon l'unique filet
   anti-marqueurs est contourné et un `kisso_XXXX` se rejouerait à chaque tour.

### D5 — Routage collant

Le repli par défaut (ligne 352, `onboardingOrchestrator` en dur) devient « l'agent qui mène le fil » :

```
1. ORCHESTRATOR_INTENTS  → onboardingOrchestrator   (palier contractuel, inchangé)
2. agent du dernier tour → si conversation < 60 min  ← NOUVEAU
3. QUESTIONNAIRE_TOPICS  → questionnaireEngine
4. NOTIFICATION_TOPICS   → notificationAgent
5. défaut                → onboardingOrchestrator
```

Ajout au palier 1 : `pdf`, `guide`. Sans ambiguïté (seul l'orchestrateur porte
`generateDocument`), ce qui satisfait la règle de CLAUDE.md. **Pas** « génère » — ambigu avec
`generateQuestionnaire`.

### D6 — Garde-fous déterministes, pas textuels

`votre_email@example.com` prouve qu'une instruction texte perd contre une contrainte de schéma Zod.

- **URL** : `sanitizeAgentOutput` retire toute URL hors allowlist et journalise en `error`.
  Point de passage unique où le lien de 3:07 aurait été intercepté.
- **Email de substitution** : `findEmployeeByEmail` rejette `example.com`, `votre_email@`, etc.,
  avec un tool-result qui *instruit* le modèle. Un tool-result pèse plus lourd qu'une instruction.
- **PDF** : `generateDocument` persiste un enregistrement sans produire de fichier. Sa
  description dit désormais ce qu'il fait vraiment. La livraison réelle du PDF est un chantier
  distinct, explicitement hors périmètre.

### D7 — Dégraissage du FLOOR

Correction au rapport initial : **factoriser** le bloc STYLE dupliqué ne fait économiser aucun
token — chaque agent l'enverra toujours. Le gain vient de le **raccourcir** ; la factorisation
sert à ne le raccourcir qu'une fois.

- borner les tool-results (projection explicite) : `getEmployeeProfile` **979 → ~200 tokens** ;
- raccourcir le bloc STYLE : ~200 → ~80 tokens ;
- alléger les schémas de `scheduleReminder` et `generateDocument`.

Cible −300 tokens de FLOOR ⇒ **+900 tok/run à K=3** ⇒ budget mémoire 1 000 → ~1 900 tokens.

### D8 — UX conversationnelle

- **Accusé de réception immédiat** : le traitement LLM prend 2 à 17 s. Un marqueur de progression
  est posté dès l'ACK, puis remplacé par la réponse via `chat.update`. Résout la latence perçue
  et le silence apparent.
- **Anti-double-réponse** : la dédup `event_id` est un LRU **en mémoire, par instance**. Deux
  instances Vercel traitent le même rejeu → deux `postMessage`. Portée en LibSQL, la classe
  entière disparaît.
- **Ton** : le bloc STYLE raccourci conserve tutoiement, phrases courtes, pas d'énumération de
  plan, pas d'emojis décoratifs.

### D9 — Bugs ramassés au passage

- `mastra.getAgent()` **lève** au lieu de retourner `undefined` : la branche ligne 743 est morte,
  et un identifiant erroné produit le message générique.
- Le catch ne dit ni quel agent, ni à quelle phase, ni si un outil a été appelé. Ajout de
  `agentId`, `phase`, `durationMs`, `steps.length`, `usage.inputTokens`, `toolCalls`.
  Coût zéro token.

## Tests

TDD, doublures `in-memory-*` (pas de mock Drizzle). Test d'acceptation : **rejouer l'historique
réel 2:55 → 3:07** et vérifier qu'aucun tour ne redemande une information déjà donnée, qu'aucun
tour ne change d'agent, et qu'aucune URL ne sort.

## Livraison

| Lot | Contenu | Risque |
|---|---|---|
| 0 | Observabilité + dégraissage FLOOR | nul, débloque le budget |
| 1 | Mémoire | moyen |
| 2 | Routage collant | faible |
| 3 | Garde-fous + dédup persistante + `getAgent` | faible |
| 4 | Accusé de réception / progression Slack | faible |

## Hors périmètre, assumé

- Livraison réelle du PDF (`PdfmakeService` + `files.uploadV2`) — c'est ce que l'utilisateur
  demandait à 3:07, inscrit comme chantier suivant.
- Passage de Groq à un palier payant — décision budgétaire, hors code.
