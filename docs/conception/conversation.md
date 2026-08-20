# Feature `conversation`

> Décisions de conception, extraites des commentaires du code le 2026-08-20.
> Périmètre : `src/features/conversation/`
>
> Chaque entrée porte le fichier et la ligne d'origine, ainsi que la déclaration
> qu'elle précédait. Le code ne porte plus ce texte : **c'est ici qu'il vit désormais.**

---

## `features/conversation/domain/entities/conversation-turn.ts`

**L.1 — avant `export interface ConversationTurn {`**

Un tour de conversation : un message, et un seul, échangé avec un agent.

On ne stocke QUE du texte. Jamais de `tool-call`, jamais de `tool-result`
(décision D3 de la spec) : un unique retour de `getEmployeeProfile` pesait
979 tokens, soit davantage que six messages d'utilisateur réunis. Les exclure
est un levier de −63 % sur la fenêtre, gratuit.

TypeScript pur — ZÉRO import de framework, la couche `domain` ne dépend de rien.

**L.13 — avant `readonly conversationId: string;`**

 Clé dérivée du contexte Slack — voir `value-objects/conversation-id.ts`.

**L.16 — avant `readonly content: string;`**

Texte du message.
- `user` : n'est écrit qu'après avoir passé `wrapAgentInput` sans lever, donc
  un message bloqué pour injection ne se rejoue jamais (décision D4).
- `assistant` : n'est écrit qu'APRÈS `sanitizeAgentOutput`, sinon l'unique
  filet anti-marqueurs serait contourné à chaque rejeu.

**L.24 — avant `readonly agentId: string;`**

 Agent ayant produit ou reçu ce tour — porte aussi le routage collant (décision D5).

**L.26 — avant `readonly slackUserId: string | null;`**

 `null` pour un tour `assistant`, qui n'émane d'aucun humain.

**L.33 — avant `export type NewConversationTurn = Omit<ConversationTurn, 'id' | 'createdAt'>;`**

 Données d'un tour avant persistance : l'identité et l'horodatage appartiennent au dépôt.

## `features/conversation/domain/ports/conversation.repository.ts`

**L.3 — avant `export const CONVERSATION_TTL_MS = 60 * 60 * 1000;`**

TTL UNIQUE gouvernant à la fois la mémoire conversationnelle ET le routage collant
(décision D1 de la spec) : 60 minutes d'inactivité.

Un seul paramètre plutôt que trois — mémoire, collance, rétention — qui divergeraient au
premier réglage. Au-delà de ce délai, le fil est considéré clos : ni contexte rejoué, ni
agent collant.

**L.14 — avant `readonly ttlMs: number;`**

 Fenêtre de fraîcheur. En pratique `CONVERSATION_TTL_MS`.

**L.16 — avant `readonly limit: number;`**

Garde-fou de REQUÊTE (ex. 50) : plafonne ce qu'on charge avant de fenêtrer, pour ne
jamais tirer un fil entier de mille messages en mémoire. Ce n'est PAS le plafond de
contexte — celui-là se compte en tokens, via `selectWindow`.

**L.24 — avant `export interface ForgetScope {`**

Portée d'un effacement demandé par une PERSONNE — à ne pas confondre avec `prune`, qui est
une purge de rétention déclenchée par le temps.

Les deux ne peuvent pas partager une méthode : `prune` supprime ce qui est vieux, partout ;
ici on supprime ce qui appartient à quelqu'un, quel que soit son âge. Confondre les deux
donnerait à une demande d'effacement une portée globale.

**L.34 — avant `readonly slackUserId?: string | null;`**

Quand il est fourni, SEULS les tours émis par cette personne sont supprimés.

C'est ce qui distingue un DM d'un fil de canal, et la distinction est nécessaire. En DM
la conversation EST l'espace privé d'une seule personne (`deriveConversationId` retombe
sur le canal `D…`) : tout y est à elle, tours `assistant` compris, donc on efface tout.
Dans un fil de canal, plusieurs humains parlent — effacer le fil entier parce que l'un
d'eux le demande supprimerait les messages des autres, ce que personne n'a demandé.

⚠️ Les tours `assistant` portent `slackUserId: null` : filtrer par personne les laisse
donc en place. C'est correct et voulu — `selectWindow` s'arrête sur une salve
d'`assistant` sans question en amont plutôt que de la rejouer nue, donc les réponses
orphelines cessent d'être rejouées d'elles-mêmes.

**L.54 — avant `recentTurns(conversationId: string, options: RecentTurnsOptions): Promise<ConversationTurn[]>;`**

 Tours d'une conversation, du plus ancien au plus récent, ignorant ceux au-delà du TTL.

**L.57 — avant `prune(olderThan: Date): Promise<number>;`**

 Purge les tours au-delà du TTL. Appelé opportunément, pas par un cron.

**L.60 — avant `forget(scope: ForgetScope): Promise<number>;`**

Efface à la demande, et rend le NOMBRE de tours réellement supprimés.

Le compte n'est pas un confort de journalisation : c'est lui qui permet à la réponse de
dire ce qui s'est passé plutôt que de l'affirmer. Sans lui, le bot ne pourrait que
réciter « c'est fait » — précisément le défaut que ce dépôt corrige partout ailleurs.

## `features/conversation/domain/ports/pinned-fact.repository.ts`

**L.1 — avant `export interface PinnedFact {`**

Mémoire LONGUE : les faits qu'une personne a explicitement demandé de retenir.

── Pourquoi un port distinct de `ConversationRepository` ───────────────────
Les deux stockent du texte d'une personne, et c'est leur seul point commun. `conversation`
est une FENÊTRE : TTL de 60 minutes, éviction par budget de tokens, purge opportuniste —
tout y est destiné à disparaître. Ici, rien ne disparaît sans une demande explicite.

Fondre les deux derrière un drapeau `pinned` aurait mis deux durées de vie opposées sous
la même purge, avec un `WHERE pinned = 0` qu'un futur correctif finirait par oublier une
fois. La séparation rend l'invariant structurel plutôt que conventionnel.

── La clé est la PERSONNE, pas la conversation ─────────────────────────────
« mon poste est Backend Developer » vaut dans tous les fils. C'est aussi ce qui permet à
l'effacement de les emporter par la même clé, quel que soit l'endroit où il est demandé.

**L.20 — avant `readonly fact: string;`**

 Texte D'ORIGINE de la personne, assaini. Jamais normalisé ni reformulé.

**L.26 — avant `list(slackUserId: string, limit: number): Promise<PinnedFact[]>;`**

 Les faits d'une personne, du plus ancien au plus récent, bornés à `limit`.

**L.29 — avant `pin(fact: PinnedFact, max: number): Promise<void>;`**

Épingle un fait, en évinçant le plus ancien si le plafond est atteint.

L'éviction fait PARTIE du contrat, elle n'est pas laissée à l'appelant : c'est elle qui
garantit que le préambule système ne grossit jamais, et un appelant qui l'oublierait ne
s'en apercevrait qu'au sixième fait.

**L.38 — avant `forget(slackUserId: string): Promise<number>;`**

 Efface tous les faits d'une personne. Rend le nombre de lignes supprimées.

## `features/conversation/domain/services/token-window.ts`

**L.3 — avant `export const CHARS_PER_TOKEN = 3.5;`**

Fenêtrage de l'historique conversationnel, EN TOKENS et jamais en nombre de messages
(décision D3 de la spec).

Pourquoi pas un plafond en messages : les tours n'ont pas de taille comparable. Un
« Par email » pèse 3 tokens, un retour d'outil en pèse 979. Compter les messages, c'est
ne rien plafonner du tout — et le plafond Groq de 12 000 tokens/minute est la limite qui
casse la production aujourd'hui. Rappel de l'arithmétique : le préfixe est repayé
intégralement à CHAQUE aller-retour, donc un run de K étapes facture chaque token de
mémoire K fois.

TypeScript pur — ZÉRO import de framework.

**L.17 — avant `export const CHARS_PER_TOKEN = 3.5;`**

Caractères par token. Ratio calibré sur les mesures réelles du projet et non sur une
moyenne générique : l'en-tête `SYSTEM_SECURITY_PROMPT` fait 1308 caractères pour
374 tokens mesurés en production le 2026-08-08, soit 3,497 — arrondi à 3,5.
L'incertitude résiduelle est de l'ordre de ±10 %, absorbée par la marge du budget.

**L.25 — avant `export const CONVERSATION_TOKEN_BUDGET = 1600;`**

Budget par défaut alloué à l'historique.

Dimensionné sur `onboardingOrchestrator`, l'agent le plus coûteux, à K=3 étapes — le cas
qui touchait le plafond. Deux mesures du 2026-08-11 (`_measure.mts`) fixent la marge :

 - FLOOR ramené de 2100 à **1458 tokens** (instructions raccourcies et factorisées,
   schémas d'outils allégés) ;
 - retour de `getEmployeeProfile` ramené de 2506 à **329 tokens** par appel — c'était le
   poste dominant d'un flux à plusieurs étapes, bien avant l'historique.

Budget disponible qui en résulte : `(12000 − 3 × 1458) / 3 ≈ 2540` tokens. On retient
**1600**, soit ~37 % de marge. Le surdimensionnement de la marge est délibéré : au-delà du
plafond Groq l'échec n'est pas une dégradation mais un HTTP 500, et le repli Mistral a lui
aussi échoué le 2026-08-08. Mieux vaut une mémoire un peu courte qu'un bot muet.

Soit ~10 messages de texte courant, contre 6 avant le dégraissage.

**L.45 — avant `export const MAX_TURN_BUDGET_SHARE = 0.4;`**

Part maximale du budget qu'un tour isolé peut occuper. Au-delà, il est TRONQUÉ et non exclu :
un message géant avalerait sinon toute la fenêtre à lui seul, et l'exclure ferait disparaître
du contexte le message le plus substantiel de l'échange.

**L.52 — avant `const TRUNCATION_SUFFIX = '…';`**

 Marqueur de troncature. Un seul caractère, donc un coût négligeable.

**L.55 — avant `export function estimateTokens(content: string): number {`**

 Coût estimé d'un contenu, en tokens.

**L.60 — avant `export function selectWindow(`**

Sélectionne les tours les plus récents tenant dans `budgetTokens`.

- parcours du plus RÉCENT au plus ancien, accumulation jusqu'au budget ;
- **une paire `user`/`assistant` n'est JAMAIS coupée** : si la paire complète n'entre pas
  dans le budget restant, on s'arrête là. Un tour `assistant` orphelin répondrait à une
  question invisible pour le modèle — c'est pire que pas de mémoire du tout, parce que le
  modèle prend cette réponse pour un fait établi sans jamais pouvoir la rattacher ;
- un tour dépassant 40 % du budget est tronqué (fin coupée, suffixe « … ») ;
- le résultat est rendu en ordre CHRONOLOGIQUE, prêt à être posé tel quel dans les messages.

@param turns tours du plus ancien au plus récent (l'ordre rendu par le dépôt).

**L.80 — avant `const units: ConversationTurn[][] = [];`**

 Unités retenues, du plus récent au plus ancien ; remises à l'endroit à la sortie.

**L.84 — avant `let index = turns.length - 1;`**

Parcours à rebours par UNITÉS indivisibles. Une unité vaut soit un tour `user` seul

**L.85 — avant `let index = turns.length - 1;`**

(question encore sans réponse), soit un tour `user` suivi de TOUTE la salve d'`assistant`

**L.86 — avant `let index = turns.length - 1;`**

qui lui répond — le bot poste parfois deux messages pour un seul message utilisateur, et

**L.87 — avant `let index = turns.length - 1;`**

les séparer recréerait exactement l'orphelin qu'on cherche à éviter.

**L.94 — avant `if (start < 0 || turns[start].role !== 'user') break;`**

Salve d'assistants sans question en amont : le tour utilisateur est hors fenêtre

**L.95 — avant `if (start < 0 || turns[start].role !== 'user') break;`**

(purgé par le TTL ou coupé par le `limit`). On s'arrête plutôt que de le rejouer nu.

**L.102 — avant `if (unitCost > remaining) break;`**

On s'arrête — on ne saute PAS l'unité pour tenter la suivante : sauter donnerait un

**L.103 — avant `if (unitCost > remaining) break;`**

historique troué, où deux tours consécutifs en apparence ne le sont pas.

**L.114 — avant `function truncateToBudget(turn: ConversationTurn, maxTurnTokens: number): ConversationTurn {`**

Tronque un tour au plafond par tour. Renvoie le tour d'origine s'il tient déjà — on ne
mute jamais l'entrée, le dépôt peut la réutiliser.

## `features/conversation/domain/value-objects/conversation-id.ts`

**L.1 — avant `export interface SlackConversationRef {`**

Dérivation de la clé de conversation depuis le contexte Slack (décision D1 de la spec) :

    conversationId = threadTs ? `${channel}:${threadTs}` : channel

Pourquoi cette règle exactement, et pas « toujours threader » :

- **En DM, `threadTs` est `undefined` PAR CONCEPTION.** Threader un DM avait rendu le bot
  silencieux en production ; le handler Slack ne calcule donc aucun `thread_ts` sur un
  `channel_type === 'im'`. La conversation est alors le canal `D…` lui-même : un DM est un
  fil unique et continu entre un humain et le bot, ce qui est exactement le comportement
  attendu de la mémoire.

- **En canal, l'appelant passe `thread_ts ?? ts`.** Un thread est une conversation : tous ses
  messages partagent le `thread_ts` de leur racine. Un message posté hors thread ouvre la
  sienne, identifiée par son propre `ts` — sans quoi tout le canal, toutes discussions et tous
  interlocuteurs confondus, formerait une seule mémoire commune.

Conséquence assumée : en canal, deux messages racine successifs du même utilisateur sont deux
conversations distinctes. C'est le prix de l'isolement entre threads, et Slack n'offre pas de
meilleur discriminant.

TypeScript pur — ZÉRO import de framework.

**L.27 — avant `readonly channel: string;`**

 Identifiant de canal Slack : `D…` (DM), `C…` (public), `G…` (privé).

**L.29 — avant `readonly threadTs?: string | null;`**

 `thread_ts ?? ts` en canal ; `undefined` en DM, par conception.

**L.36 — avant `throw new Error('deriveConversationId: channel is required');`**

Sans cette garde, une clé vide fusionnerait TOUTES les conversations en une seule

**L.37 — avant `throw new Error('deriveConversationId: channel is required');`**

mémoire partagée — une fuite de contexte entre utilisateurs, pas un simple bug.

## `features/conversation/infrastructure/repositories/drizzle-conversation.repository.ts`

**L.16 — avant `export class DrizzleConversationRepository implements ConversationRepository {`**

Persistance des tours de conversation sur LibSQL/Turso.

⚠️ La table `conversation_turns` n'est PAS créée par les migrations `drizzle/` : celles-ci
sont désynchronisées de `schema.ts`, et `drizzle-kit push` se bloque indéfiniment contre une
base `libsql://` distante. Le DDL à appliquer à la main vit dans
`scripts/ddl-conversation-turns.sql`.

**L.47 — avant `const rows = await db`**

Tri DESC + `limit` pour tirer les tours les plus RÉCENTS — un `limit` sur un tri ASC

**L.48 — avant `const rows = await db`**

ramènerait le début du fil, c'est-à-dire exactement ce qu'on veut oublier.

**L.61 — avant `return rows.reverse().map(toDomain);`**

Remis à l'endroit : le port promet du plus ancien au plus récent.

**L.73 — avant `async forget(scope: ForgetScope): Promise<number> {`**

Effacement à la demande. Aucune borne de temps : on supprime ce qui appartient à la
personne, y compris les tours plus récents que le TTL — c'est tout l'objet de la demande.

⚠️ Sans `slackUserId`, la clause ne porte QUE sur `conversationId`. C'est l'appelant qui
garantit qu'on est en DM (donc dans un espace à une seule personne) ; le dépôt, lui, ne
connaît pas la topologie Slack et n'a pas à la deviner.

**L.100 — avant `role: row.role as ConversationRole,`**

SQLite ne connaît pas les unions littérales : la colonne est un `text` libre, la

**L.101 — avant `role: row.role as ConversationRole,`**

contrainte vit dans le domaine.

## `features/conversation/infrastructure/repositories/drizzle-pinned-fact.repository.ts`

**L.6 — avant `export class DrizzlePinnedFactRepository implements PinnedFactRepository {`**

Persistance des faits épinglés sur LibSQL/Turso.

⚠️ La table `pinned_facts` n'est PAS créée par les migrations `drizzle/` : celles-ci sont
désynchronisées de `schema.ts`, et `drizzle-kit push` se bloque indéfiniment contre une base
`libsql://` distante. Le DDL à appliquer à la main vit dans `scripts/ddl-pinned-facts.sql`,
et il doit l'être AVANT le déploiement.

**L.23 — avant `.orderBy(asc(pinnedFacts.createdAt))`**

Du plus ANCIEN au plus récent : c'est l'ordre dans lequel la personne les a donnés,

**L.24 — avant `.orderBy(asc(pinnedFacts.createdAt))`**

donc celui qui se lit. Le tri est explicite — sans `ORDER BY`, deux lectures

**L.25 — avant `.orderBy(asc(pinnedFacts.createdAt))`**

identiques peuvent rendre deux ordres différents (défaut déjà corrigé sur

**L.26 — avant `.orderBy(asc(pinnedFacts.createdAt))`**

`getNotificationHistory`).

**L.33 — avant `async pin(fact: PinnedFact, max: number): Promise<void> {`**

⚠️ L'éviction se fait AVANT l'insertion, et sur `max - 1`.

L'ordre importe : évincer après l'insertion supprimerait le fait qu'on vient d'ajouter
si l'horodatage se trouvait être le plus ancien (deux écritures dans la même
milliseconde, cas réel en serverless). On fait donc de la place, puis on écrit.

Il n'y a PAS de transaction : LibSQL en supporte, mais le pire cas ici est de retomber
sous le plafond d'un fait pendant quelques millisecondes — sans conséquence, la borne
n'existant que pour le budget de tokens.

**L.72 — avant `return (result as { rowsAffected?: number }).rowsAffected ?? 0;`**

`rowsAffected` est le champ rendu par le pilote libsql. Le contrat rend un NOMBRE et

**L.73 — avant `return (result as { rowsAffected?: number }).rowsAffected ?? 0;`**

non `void` pour la même raison que `OnboardingRepository.update` : sans lui, aucun

**L.74 — avant `return (result as { rowsAffected?: number }).rowsAffected ?? 0;`**

appelant ne peut distinguer une suppression réussie d'une suppression sur zéro ligne,

**L.75 — avant `return (result as { rowsAffected?: number }).rowsAffected ?? 0;`**

et la réponse rendue à la personne annoncerait un effacement qui n'a pas eu lieu.

## `features/conversation/infrastructure/repositories/in-memory-conversation.repository.ts`

**L.11 — avant `export class InMemoryConversationRepository implements ConversationRepository {`**

Doublure de test du `ConversationRepository`. Même contrat, même sémantique de TTL et de
`limit` que l'implémentation Drizzle — c'est elle qui sert de doublure dans les tests
unitaires, on ne mocke jamais Drizzle à la main.

Les tours sont conservés dans leur ordre d'insertion, qui EST l'ordre chronologique : aucun
tri n'est nécessaire, ce qui évite l'instabilité sur deux tours horodatés à la même
milliseconde.

**L.41 — avant `return options.limit > 0 ? alive.slice(-options.limit) : [];`**

`slice(-limit)` : on garde les PLUS RÉCENTS, tout en rendant l'ordre chronologique.

**L.51 — avant `async forget(scope: ForgetScope): Promise<number> {`**

 Même sémantique que l'implémentation Drizzle : aucune borne de temps, un compte rendu.

**L.57 — avant `return scope.slackUserId ? turn.slackUserId !== scope.slackUserId : false;`**

Filtrer par personne épargne les tours `assistant` (`slackUserId: null`) : voir le

**L.58 — avant `return scope.slackUserId ? turn.slackUserId !== scope.slackUserId : false;`**

commentaire du port, c'est voulu.

**L.65 — avant `clear(): void {`**

 Confort de test : vide le dépôt entre deux cas.

## `features/conversation/infrastructure/repositories/in-memory-pinned-fact.repository.ts`

**L.3 — avant `export class InMemoryPinnedFactRepository implements PinnedFactRepository {`**

Doublure de `DrizzlePinnedFactRepository`.

⚠️ Elle doit reproduire EXACTEMENT l'éviction : faire de la place AVANT d'insérer, sur
`max - 1`. Une doublure plus permissive validerait en test un plafond que la production
n'applique pas — et ce plafond est ce qui empêche le préambule système de grossir sans
borne, à chaque aller-retour, sur un budget de ≈ 19 messages par jour.

