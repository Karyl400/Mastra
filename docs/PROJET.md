# Marcel — plateforme d'onboarding conversationnel de Kisso Industries

> **Portée de ce document.** Il décrit le DÉPÔT au 2026-08-25, commit `96d9307`, branche
> `refactor/cleanup-20260810`. Le dépôt et la production divergent régulièrement : avant toute
> conclusion sur un comportement observé dans Slack, vérifier ce qui tourne réellement
> (`npx vercel ls`, puis `git log --oneline -1`). Aucun chiffre de ce document n'est repris de
> mémoire ; chacun est accompagné de la commande qui le régénère.

---

## 1. Le but

Un nouvel employé rejoint Kisso Industries. Trois choses doivent arriver, et elles arrivaient mal :
son dossier doit exister, il doit savoir à qui parler, et il ne doit pas avoir à lire un manuel
pour ça.

**Marcel est un collègue joignable dans Slack.** On lui écrit en français, en DM ou en canal, et
il répond : il ouvre un dossier, produit un document, envoie un email, programme un rappel qui
part vraiment, dit qui s'occupe du backend, résume ce qui s'est dit dans un canal.

Ce que le produit **ne fait pas**, et le dit : il ne provisionne aucun compte, ne construit aucun
planning, n'administre aucun questionnaire, n'exécute aucun code. Ces absences sont écrites dans
les instructions des agents sous forme d'énumération négative — c'est le seul refus correct qu'un
modèle produise de façon fiable.

**La contrainte fondatrice n'était pas technique mais économique.** Le palier gratuit du
fournisseur de modèle accordait 100 000 tokens par JOUR, soit ≈ 19 messages. Tout ce dépôt est
construit autour de cette borne : neuf réponses ne coûtent aucun token, le poste de coût
surveillé est le NOMBRE D'ÉTAPES et non la taille du prompt, et chaque décision de conception se
justifie en aller-retours épargnés. La contrainte a été levée le 2026-08-20 (passage à Gemini),
mais l'architecture qu'elle a produite est restée — elle vaut pour elle-même.

---

## 2. Ce que le produit sait faire

| Capacité | Déclencheur | Ce qui se passe réellement |
| --- | --- | --- |
| **Ouvrir un dossier** | « je veux compléter mon profil », ou l'arrivée dans le workspace | Quatre questions au plus, une par message, l'annuaire Slack pré-remplissant ce qu'il sait |
| **Vérifier un dossier** | « j'ai fini » | Verdict prononcé sur la BASE, jamais sur ce qu'on croit savoir |
| **Entretien** | après la création du dossier | Trois champs libres (quotidien, façon de travailler, canaux) — et les canaux choisis sont réellement rejoints |
| **Produire un document** | « génère-moi le guide en PDF » | PDF ou DOCX réel, uploadé dans le fil Slack, ou en pièce jointe email si Slack échoue |
| **Corriger un document** | « corrige la partie sur les congés » | Même identifiant, `update` et non `save`, document RELIVRÉ |
| **Envoyer un email / une notification** | « préviens Awa que… » | Envoi réel par SMTP, statut honnête (`failed` si rien n'est parti) |
| **Programmer un rappel** | « rappelle-moi lundi de… » | Enregistré, puis **remis par un cron quotidien** — il part sans qu'on repasse le demander |
| **Convoquer un candidat** | « envoie un email d'entretien à jean@… pour le 20 août à 14h » | Le tool PRÉPARE, un humain relit, « oui » envoie. Le modèle n'écrit aucune prose sortante |
| **Trouver une personne** | « qui s'occupe du backend ? », « l'email de Karyl » | Deux sources (dossiers + annuaire Slack) ; sur ambiguïté, AUCUN identifiant ne sort |
| **Résumer un canal** | « résume ce qui s'est dit dans #kisso-hq » | Extraits choisis par SAILLANCE, jamais par récence, avec la couverture collée au contenu |
| **Chercher dans la connaissance** | « qu'est-ce qui a été décidé sur postgres ? » | Recherche FTS ; base muette ⇒ relecture en direct des canaux dont le DEMANDEUR est membre |
| **Oublier** | « oublie ce que je t'ai dit » | Efface réellement. En DM tout part, en fil de canal seulement les tours du demandeur |
| **Se souvenir** | « souviens-toi que… » | Fait épinglé hors TTL, restitué comme une DÉCLARATION de la personne, jamais comme une consigne |

**Treize outils, quatre agents.** Le nombre n'est énuméré nulle part dans le code — il se
recompte : `ls src/features/*/application/tools/*.ts | wc -l`.

---

## 3. L'architecture

### 3.1 Screaming Architecture, par feature

```
src/features/<feature>/
├── domain/           entités, value-objects, ports — TypeScript pur, ZÉRO import framework
├── application/      agents, tools, workflows, dtos, mappers — ce que Mastra consomme
└── infrastructure/   repositories (Drizzle + in-memory), providers, services, handlers
```

Huit features : `employee`, `onboarding`, `document`, `notification`, `conversation`,
`directory`, `knowledge`, `recruitment`.

**Règle de dépendance** : `domain` ne dépend de rien ; `application` dépend de `domain` ;
`infrastructure` implémente les ports du `domain`. Jamais l'inverse.

Cette règle n'est pas une convention : `tests/unit/quality/architecture.test.ts` la calcule
depuis le graphe d'imports réel. Elle couvre aussi `src/shared/` et les arêtes
infrastructure↔infrastructure entre features — quatre arêtes légitimes subsistent, inscrites en
**dette nommée**, et un second test fait rougir toute entrée de la liste dont l'arête a disparu.
La liste ne peut que rétrécir.

### 3.2 Injection de dépendances, sans conteneur

Tout composant Mastra est produit par une factory qui reçoit ses dépendances :
`makeCreateEmployee(repo)`, `makeOnboardingOrchestrator(tools)`. **Jamais d'instanciation au
niveau module dans `features/`** — le câblage vit exclusivement dans `src/mastra/index.ts`.

Conséquence pratique : les repositories `in-memory-*` servent de doublure dans les tests, et
aucun test ne mocke Drizzle à la main.

### 3.3 Le contexte Slack ne traverse jamais la fenêtre du modèle

Un tool reçoit ses arguments du modèle, et le modèle ne connaît pas — et ne doit pas connaître —
l'identifiant d'un canal ni l'identité du demandeur. Le handler construit un `RequestContext`
(`src/shared/slack-request-context.ts`) passé à `agent.generate(messages, { requestContext })`.

⚠️ En Mastra 1.57 c'est bien `requestContext`, **plus `runtimeContext`**.

**Coût en tokens : ZÉRO.** C'est un canal d'injection de dépendances côté serveur ; il ne traverse
ni le prompt, ni les schémas de tools, ni les tool-results. C'est aussi ce qui rend la frontière
d'autorisation sûre : on ne décide pas d'un droit sur une valeur qu'un attaquant écrit.

---

## 4. Le trajet d'un message

L'ordre compte, et il est contre-intuitif : **le modèle intervient en avant-dernier**, et la
plupart des étapes ne lui coûtent rien.

1. **Le portier d'ACK** — une seconde fonction Vercel, 24 Ko, **zéro `node_modules`**. Il vérifie
   la signature HMAC, répond à Slack, et rejoue la requête vers la route applicative.
2. **Signature** — HMAC-SHA256 sur `v0:timestamp:body`, comparaison à temps constant, rejet
   au-delà de 5 min.
3. **Déduplication** — clé `ts:<channel>:<ts>`, prise d'abord en LRU local, puis dans un store
   Turso partagé (`INSERT … ON CONFLICT DO NOTHING`, donc atomique entre instances).
4. **Filtrage** — ses propres messages, les messages de canal hors fil.
5. **Limite de débit** — rafale (5/min) et quota journalier. Le quota journalier ÉPARGNE les
   réponses qui ne coûtent rien.
6. **Archivage** — le message brut entre dans `channel_messages`, puis `distillFact` en tire
   éventuellement un fait. Du CODE, zéro token.
7. **Neuf court-circuits déterministes** — voir §5.
8. **Frontière d'autorisation** — voir §7.
9. **Routage en quatre temps** — voir §6.
10. **Mémoire** — fenêtrage en TOKENS, jamais en nombre de messages.
11. **Préambule d'identité** — nom du demandeur, date du jour, dans un message `system`.
12. **Encadrement anti-injection** — le texte utilisateur est borné par un délimiteur unique.
13. **Le modèle** — Gemini, repli Groq, dernier recours Mistral. L'ORDRE EST LE CONTRAT.
14. **Réconciliation FAIT / NARRATION** — voir §8.
15. **Assainissement de sortie** — marqueurs internes, URL hors liste blanche, markdown → mrkdwn.

Le marqueur de progression (« Je regarde ça, un instant… ») est posté immédiatement et **remplacé**
par la réponse via `chat.update` : un seul message dans le fil.

---

## 5. Neuf réponses qui ne coûtent aucun token

Chacune est un prédicat pur suivi d'une réponse écrite en dur, dans `handleMessage` :

| # | Cas | Module |
| --- | --- | --- |
| 1 | salutation nue | `shared/greeting.ts` |
| 2 | pièce jointe (`subtype: file_share`) | `slack-events.handler.ts` |
| 3 | message sans contenu textuel | `shared/message-shape.ts` |
| 4 | message trop long | `shared/message-shape.ts` |
| 5 | **détresse** | `shared/distress.ts` |
| 6 | **effacement** — le seul qui AGISSE | `shared/forget.ts` |
| 7 | demande du formulaire de profil | `shared/profile-request.ts` |
| 8 | mémorisation explicite | `shared/pin-fact.ts` |
| 9 | déclaration de profil terminé | `shared/profile-done.ts` |

Deux d'entre eux méritent d'être détaillés.

**La détresse distingue deux cas depuis le 2026-08-21.** Le module n'en connaissait qu'un :
« je suis harcelé par mon manager » recevait le message de prévention du suicide — la détection
était bonne, la réponse était à côté. `distressKind()` rend `self_harm | aggression`, et
`self_harm` l'emporte en cas de doute : traiter une agression comme une détresse donne quand même
un numéro joignable, l'inverse remplace une aide vitale par une démarche administrative.

Les numéros vivent dans `src/shared/emergency-lines.ts`, **chacun avec sa source**. Bénin par
défaut : `117` (Police Républicaine) et `112` (SAMU). **Trois numéros ont été écartés à la
vérification, et chacun aurait été une faute plausible** : le 122 est congolais, le 143 ivoirien,
le 3114 français. Les trois sont réels, gratuits, et joignent quelqu'un — dans un autre pays.

**L'effacement est le seul court-circuit irréversible**, et son critère porte sur un ACTE DE
LANGAGE, pas sur la présence de mots. Une revue adversariale a reproduit une perte de données sur
la première version : « Je ne veux surtout pas que tu oublies ce que je t'ai dit » — qui demande
le contraire — effaçait. Le verbe doit désormais ouvrir le message ou suivre une formule de
demande, et la négation est cherchée sur quatre mots des deux côtés.

**Le miroir.** La limite de débit vit AVANT les court-circuits. Une personne ayant atteint son
quota recevait donc « J'ai atteint mon quota » pour un simple « bonjour » — et l'aurait reçu pour
« je ne vais pas bien ». `isAnsweredWithoutModel` est le miroir exact de ces neuf cas, et un test
le vérifie entrée par entrée avec une charge d'essai par nom.

---

## 6. Le routage — quatre temps, dérivés du câblage

1. **ÉCHAPPEMENT** (`ESCAPE_INTENTS`) — symétrique, l'ordre du tableau EST la priorité. Critère
   d'admission, plus strict que « désigne cet agent » : le terme doit **ouvrir une tâche
   nouvelle**, pas continuer celle en cours.
2. **COLLANT** — l'agent du dernier tour du fil, si celui-ci a moins de 60 minutes.
3. **THÉMATIQUE**, exprimé en **CAPACITÉS** : chaque bande exige un outil (`generateDocument`,
   `sendNotification`, `getChannelHistory`, `findExpertise`) et déclare si elle peut déloger un
   fil.
4. **Défaut** → `onboardingOrchestrator`.

**Le palier 3 peut déloger le palier 2 à une seule condition : l'agent qui mène le fil ne porte
pas l'outil exigé.** La règle est DÉRIVÉE de `AGENT_TOOLS` — déplacer un outil d'un agent à
l'autre change le routage tout seul. Elle est sûre dans les deux sens : elle ne peut jamais
arracher un fil à un agent qui sait répondre, ni le laisser chez un agent qui ne sait pas.

C'est la correction de deux défauts mesurés en production : l'alternance A → B → A entre agents
amnésiques (2026-08-11), puis l'état absorbant qui gardait « Génère-moi le guide en PDF » chez un
agent sans `generateDocument` pendant une heure (2026-08-12).

---

## 7. Sécurité

### 7.1 Anti prompt-injection

Chaque agent commence ses `instructions` par `SYSTEM_SECURITY_PROMPT`
(`src/shared/security/llm-guardrail.ts`), et tout texte utilisateur est borné par un délimiteur
unique par processus. `validateDelimiterIntegrity` rejette toute seconde balise ouvrante.

⚠️ **Un prompt ne doit jamais prescrire une sortie que le filtre de sortie censure.** La directive
6.1 ordonnait de répondre `[SECURITY_BLOCK] …` — chaîne présente dans `INTERNAL_MARKERS` : toute
réponse OBÉISSANT à la directive était détectée comme fuite et remplacée en bloc. La feature était
cassée par le garde-fou censé la protéger, et le symptôme est indiscernable d'une panne. Un test
d'invariant interdit désormais toute prescription d'un marqueur interne.

### 7.2 La frontière d'autorisation

`full` ⟺ **`slack_directory.role = 'manager'`**. Tous les autres gardent leur propre dossier et le
droit d'agir dessus.

- La colonne est sur `slack_directory`, **pas sur `employees`** : le General Manager n'a aucune
  ligne dans `employees`, et 5 des 6 personnes vivantes non plus. Le sujet d'une décision
  d'autorisation n'est pas un dossier RH, c'est un membre du workspace.
- `title` ne décide rien — c'est un champ déclaratif, édité par son porteur. Une autorisation qui
  en dériverait s'obtiendrait en la déclarant.
- Le garde **refuse d'appliquer tant qu'aucun manager n'est désigné** : la colonne naît vide, donc
  « aucun manager » est l'état de départ. Appliquer rétrograderait l'organisation entière.
- `AUTHZ_ENFORCE=true` est posé en production depuis le 2026-08-20. Vérifié par deux sondes
  signées, **les deux moitiés** : le refus sur le dossier d'autrui ET le succès sur le sien — un
  refus généralisé est indiscernable d'une frontière qui marche.
- Avant activation : `npm run probe:authz` évalue tout l'annuaire d'un coup, en lecture seule, en
  IMPORTANT `resolveAccess`. Le mode observation ne journalise que les gens qui écrivent au bot,
  or c'est celui qui ne lui a jamais parlé qu'on cassera.

### 7.3 Quarantaine des outils

`outbound-tool-quarantine.ts` §4.2 interdit la CONJONCTION lecture agrégée + écriture externe.
Il y a deux façons de la former selon le côté par lequel on arrive, donc deux gardes :

- `getChannelHistory` et `getUserConversations` restent au SEUL `knowledgeAgent`, qui ne porte ni
  `generateDocument` ni `sendNotification`.
- `makeRecruitmentAgent` **lève au démarrage** si on lui câble un outil dont le nom commence par
  `find|get|list|read|search`.

C'est la limite exacte de « n'importe quel agent peut interroger la connaissance » : les
PERSONNES oui, les CANAUX non.

### 7.4 Les surfaces fermées

- **Le prompt système fuyait par `/api/agents/*`** — quatre surfaces, dont deux ne demandaient
  aucune ruse : un simple `GET` rendait les instructions des quatre agents en clair.
  `createAgentApiGuard` rédige récursivement, refuse les demandes d'extraction à l'entrée, et
  rédige les marqueurs en sortie. **Rédaction inconditionnelle, développement compris** : un
  développeur a le source, seul quelqu'un qui n'a pas le dépôt a besoin de cette route.
- **`requestContext` était forgeable par le corps HTTP.** Mastra fusionne `body.requestContext`
  dans le contexte serveur et n'écarte que des clés réservées, dont aucune `slack*` — or c'est sur
  ces clés que se décident les droits. Un porteur du jeton de service se déclarait donc n'importe
  qui. `createRequestContextGuard` **REFUSE** (400) au lieu d'assainir, et surveille un PRÉFIXE et
  non une liste recopiée : les clés pas encore écrites sont couvertes d'avance.
- **Le CONTENU d'un document était un canal de sortie non filtré.** `sanitizeAgentOutput` n'a
  qu'un seul site d'appel — `response.text` — et les arguments de tool n'y passent jamais. Vérifié
  en décodant la CMap de vrais PDF : les marqueurs internes s'imprimaient intégralement, sans le
  moindre log. Le filtre est posé au seuil du RENDU **et** dans le tool, parce que la persistance
  et la journalisation vivent en dehors du renderer.

### 7.5 ReDoS

Un message de 8 000 caractères — exactement la borne acceptée — de la forme `<a` suivi d'espaces
bloquait `wrapUserInput` **106 secondes**. Le correctif est nécessaire indépendamment des
appelants : une fonction qui met 106 s sur une entrée que sa propre borne accepte est cassée.

Le test porte sur les FONCTIONS et non sur les motifs — un test qui recopie les expressions
régulières vérifie une liste, pas un produit. **89 charges adverses** sur les deux portes
d'entrée réelles, dont une batterie générique de 13 amorces × 6 remplissages qui couvre d'avance
les motifs futurs.

---

## 8. L'honnêteté comme propriété vérifiable

C'est le fil qui traverse tout le projet, et il vient d'un verdict d'utilisatrice testeuse :
*« il parle exactement de la même façon quand il a fait le travail et quand il l'a inventé »*.

### 8.1 Réconciliation FAIT / NARRATION

Le handler est le seul point qui voie à la fois la réponse et la trace d'exécution. Une formule
d'accompli (`ACCOMPLISHMENT_CLAIMS`, **14 familles**, recomptées le 2026-08-25 ; un second détecteur, `FUTURE_DELIVERY_CLAIMS`, en porte **7** de plus au futur) alors que `response.toolCalls` est vide ⇒ la
réponse est **requalifiée** par une note accolée, jamais bloquée.

- On cherche une CONTRADICTION, jamais une invraisemblance : « je peux t'envoyer… » n'en est pas
  une. Le filtre interrogatif compte plus que les motifs — sans lui, « Tout est bon pour toi ? »
  se ferait requalifier.
- `null` (trace illisible) **n'est pas** `[]` (zéro appel) : sans preuve positive, on se tait.
- La note n'entre pas en mémoire : la rejouer apprendrait au modèle à imiter le démenti.
- Prérequis : `readToolCalls` journalisait `"unknown"` sur 100 % des appels. Le champ ajouté pour
  distinguer une action d'une narration ne répondait à aucune question.

⚠️ **Un détecteur encode le câblage ; quand le câblage bouge, il ne devient pas inoffensif, il
devient faux dans l'autre sens.** `onlyNonDeliveringTools` ne contenait que `scheduleReminder` et
n'avait de sens que tant que rien ne partait ; le jour où le cron a été livré, la garder aurait
fait démentir une phrase VRAIE.

### 8.2 On retire de quoi mentir, plutôt que d'interdire de mentir

Le tool de rappel rendait `scheduledAt` brut et un libellé à l'heure près, alors que le plan
d'hébergement ne garantit l'heure qu'à ±59 min. Il ne rend plus que `deliveredOn: 'le lundi
24 août 2026 au matin'`.

Même geste ailleurs : le tool de document n'accepte que l'UUID et jamais une adresse produite par
le modèle ; le rideau à faits fait désigner le modèle par un RANG (1..5) et jamais par un
identifiant, parce qu'un identifiant qu'on demande au modèle est un identifiant qu'il peut
inventer — et qu'il peut simplement recopier de travers, ce qui échoue en silence.

### 8.3 Une consigne est probable, le code est garanti

Mesuré quatre fois en échec sur ce dépôt. La règle qui en découle : quand une propriété doit
tenir, elle est CALCULÉE.

- `agentToolBoundary(tools)` est dérivé de `Object.keys(tools)`, jamais rédigé. Des instructions
  ont déjà nommé des outils supprimés depuis des semaines.
- Le `recipient` d'un document est nommé PAR LE CODE : la consigne existait depuis dix jours et
  deux sondes ont montré que le modèle ne la suivait pas.
- La couverture des extraits est placée juste AVANT les extraits, dans le même champ. Un champ
  séparé nommé `coverage` a été ignoré ; renommé `hint`, ignoré aussi. **Un champ séparé se lit
  comme une métadonnée, quel que soit son nom.**

### 8.4 Les tests de qualité

Douze fichiers sous `tests/unit/quality/` ne testent aucune fonctionnalité — ils verrouillent des
propriétés du dépôt lui-même :

| Test | Ce qu'il empêche |
| --- | --- |
| `architecture.test.ts` | une arête d'import interdite |
| `claimed-invariants.test.ts` | une phrase « verrouillé par `X` » citant un fichier absent |
| `comments-live-in-docs.test.ts` | le retour d'un commentaire explicatif dans `src/` |
| `dead-config-claims.test.ts` | une variable vivante rangée dans « config morte à purger » |
| `guards-are-mounted.test.ts` | un garde écrit mais non monté |
| `assistant-persona.test.ts` | une auto-désignation comme outil, agent ou IA |
| `design-docs-anchor-real-code.test.ts` | une page de conception ancrée sur du code disparu |
| `agent-wiring-is-derived.test.ts` | un câblage agent → outils recopié au lieu d'être dérivé |
| `agents-carry-security-prompt.test.ts` | un agent construit sans `SYSTEM_SECURITY_PROMPT` |
| `env-example-completeness.test.ts` | une variable lue par `src/` et absente de `.env.example` (il en manquait onze, dont `AUTHZ_ENFORCE`) |
| `tool-classification.test.ts` | un outil de lecture absent de `READ_ONLY_TOOL_NAMES` |
| `taught-phrases.test.ts` | une phrase qu'un texte du produit apprend à taper, et qu'aucun prédicat ne reconnaît |

**`claimed-invariants` est la leçon de méthode du projet.** Les trois défauts les plus coûteux
d'une revue avaient été MASQUÉS par un commentaire, et ils partagent une forme : *le commentaire
énonce une propriété GLOBALE que rien ne recalcule* (« la seule feature qui… », « verrouillé
par… », « délibérément absente »). Ce dépôt DÉRIVE ses listes ; il ne dérivait pas ses énoncés
d'invariant.

---

## 9. Le coût comme contrainte de conception

### 9.1 Ce qui coûte

Le poste dominant n'est pas la TAILLE du prompt mais le NOMBRE D'ÉTAPES : chaque étape est une
requête pleine chez tous les fournisseurs. Mesuré sur une demande de profil par email :
1 417 + 1 559 + 1 735 = **4 711 tokens d'entrée pour 3 étapes**. Un aller-retour épargné vaut
≈ 1 500 tokens ; un prompt raboté, quelques dizaines.

D'où les correctifs, par ordre d'efficacité réelle :

1. Changer de palier chez le fournisseur — pas une ligne de code, meilleur rapport effort/effet.
2. Réduire le NOMBRE D'ÉTAPES : défauts de schéma plutôt que questions posées à l'humain, tool-results
   qui INSTRUISENT plutôt qu'ils n'échouent, frontière négative pour éviter un tour de négociation stérile.
3. Alléger schémas et instructions — utile, mais rendement bien plus faible qu'on ne l'a cru
   pendant deux campagnes.

### 9.2 Le tool-result pèse plus lourd que l'historique

Un tool-result n'est pas payé une fois : il entre dans l'historique et est réémis à chaque
aller-retour suivant. Trois occurrences du même défaut :

| Tool | Avant | Après |
| --- | --- | --- |
| `getEmployeeProfile` | 2 506 tokens | 333 |
| `getNotificationHistory` | ≈ 9 600 tokens | 177 |
| `generateDocument` | 685 tokens | 39 |

`generateDocument` retournait l'entité complète, `content` compris : **il refacturait au modèle le
texte que le modèle venait d'écrire**.

⚠️ **La propriété qui compte n'est pas le chiffre mais l'INDÉPENDANCE** : la taille de ces
résultats ne dépend plus du nombre de lignes ni de la longueur du contenu. Verrouillé par
`tests/unit/tools/tool-result-budget.test.ts` — Δ = 0 caractère entre un contenu de 10 et de
11 000 caractères.

### 9.3 Ce qui a été mesuré et rejeté

- **Fusionner les agents en un seul** : les schémas des outils réunis pèsent ≈ 1 622 tokens,
  davantage que le plancher entier de l'orchestrateur — soit ≈ +80 % par aller-retour.
- **Un embedding vectoriel** : un appel de modèle par message ingéré, sur un budget qui se compte
  à la journée. La recherche est lexicale (FTS5).
- **Une boucle d'auto-correction** : elle double le nombre d'étapes, et faire réécrire au modèle
  sa propre erreur produit une version plus PLAUSIBLE sans être plus VRAIE.

---

## 10. Les contraintes du serverless

**Rien ne s'exécute tant que personne ne frappe à la porte.** La fonction ne vit que le temps
d'une requête : aucun `setTimeout` ne survit au gel, aucun processus ne tourne entre deux
messages. Trois conséquences structurantes.

**1. Le traitement de fond doit être déclaré au lanceur.** `scheduleBackgroundWork()` passe la
promesse à `waitUntil`, sans quoi la fonction gèle avant la fin de l'appel de modèle. Un garde-fou
journalise en `error` si `waitUntil` venait à disparaître — c'est la ligne à chercher si le bot
cesse de répondre.

**2. Le rappel a exigé une horloge extérieure.** `findPending()` était écrite et correcte, et
n'avait aucun appelant **parce qu'il n'existait personne pour l'appeler**. Un cron quotidien la
réveille. La granularité est un fait de plateforme, pas un choix : le plan n'autorise qu'une
exécution par jour et ne garantit l'heure qu'à ±59 min. Des deux erreurs possibles — le matin du
BON JOUR, ou le LENDEMAIN — on choisit le bon jour.

⚠️ **Une prise qui ne se termine jamais perdrait le rappel pour toujours.** L'état `sending`
interdit le doublon, mais une fonction peut être tuée entre la prise et l'envoi : le rappel
resterait invisible de toute exécution ultérieure — **pas une erreur, un SILENCE**.
`findPending()` rend donc aussi les `sending`, repris au-delà de 6 h.

**3. Les modales étaient impossibles.** Un clic signé mesuré en production : **5 229 ms à froid**,
9 173 ms sur un déploiement neuf, 684 ms à chaud. Slack accorde 3 secondes, et à ≈ 19 messages par
jour **le cas froid EST le cas nominal**. Le portier d'ACK a ramené la médiane à 734 ms — mais un
portier ne sauve pas une modale : `views.open` a lieu ensuite, dans la fonction restée froide, et
le `trigger_id` est périmé. Il ne reste donc **aucun bouton sur le chemin nominal** : la complétion
de profil et l'entretien sont des échanges écrits, à zéro token.

---

## 11. Stack et déploiement

| Élément | Valeur |
| --- | --- |
| Runtime | Node.js `>=22.13.0`, ESM |
| Langage | TypeScript `6.0.3`, strict |
| Framework | Mastra `@mastra/core` `1.57.x` |
| LLM | Gemini `gemini-3.5-flash` → repli Groq `openai/gpt-oss-120b` → dernier recours Mistral. **L'ORDRE EST LE CONTRAT**, source unique `src/shared/llm/model-fallback.ts` |
| DB | Turso / LibSQL + Drizzle ORM `0.45.x` — 21 tables |
| Validation | Zod `3.25.76`, **épinglée** |
| Tests | Vitest `4.1.10` |
| Slack | `@slack/web-api` `8.x` |
| Email | SMTP (`nodemailer`) primaire, Brevo en repli |
| Documents | `pdfmake` `0.3` et `docx` `9.7.1` — deux renderers d'un même modèle logique |
| Déploiement | Vercel, `@mastra/deployer-vercel` |

**Le bundle est élagué par ATTEIGNABILITÉ à chaque build.** Le graphe des imports littéraux est
calculé depuis les modules racines et les paquets qu'aucun chemin n'atteint sont supprimés :
178 paquets, 11 696 fichiers, 64 Mo. La fonction passe de 264 à 160 Mo.

⚠️ La liste est CALCULÉE, jamais écrite — une liste se périme au premier changement de dépendance,
en silence. Trois filets, parce que l'analyse statique ne voit pas tout : `verify:bundle` **importe
réellement** `index.mjs`, produit un vrai PDF et un vrai DOCX depuis le bundle, et refuse tout
élagage aberrant.

### Commandes

```bash
npm run dev              # serveur local + playground
npm run build            # mastra build + élagage + verify:bundle
npm run typecheck        # tsc --noEmit  (scripts/ inclus)
npm run lint             # eslint src scripts  (ne masque plus rien)
npm run test:unit        # vitest run
npm run test:integration # base isolée data/integration-test.db

npm run probe:authz      # qui perdrait quoi si AUTHZ_ENFORCE était posé (LECTURE SEULE)
npm run role:set         # inventaire des rôles ; --email <x> --apply pour désigner
npm run profile:invite   # rattrapage des personnes déjà présentes (dry-run par défaut)
```

⚠️ **Trois commandes agissent pour de bon** : `npm run smoke:email` envoie un vrai email ;
`scripts/probe-erasure.mts` supprime réellement (sauvegarder d'abord) ; `scripts/probe-arrival.mts`
écrit en base de production.

### Variables d'environnement décisives

| Variable | Sans elle |
| --- | --- |
| `DATABASE_URL` | throw au boot |
| `GOOGLE_GEMINI_API_KEY` | le primaire tombe, **sans aucun symptôme** — le repli répond jusqu'à épuisement |
| `AUTHZ_ENFORCE` | la frontière est calculée et journalisée, mais **jamais appliquée** |
| `CRON_SECRET` | la route de rappels refuse de servir (503) et **aucun rappel ne part** |
| `KNOWLEDGE_RETENTION_DAYS` | rien n'est jamais purgé — opt-in, sans valeur par défaut |

---

## 12. Ce qui reste ouvert

Honnêtement, et sans lissage :

1. **La rétention n'a jamais été configurée.** Le cron appelle fidèlement la purge chaque matin
   pour ressortir aussitôt en `enabled: false`. Ce n'est pas un défaut de code, c'est une valeur à
   poser. Le code ne se tait plus : `warn` si la variable est absente, **`error` si une valeur est
   posée puis rejetée** — ce second cas est le pire, parce qu'on croit alors avoir configuré une
   rétention.
2. **Le manager peut relire les DM de chacun.** Conséquence assumée et décidée par le
   propriétaire de l'archivage des DM. Un DM cesse d'être privé.
3. **`message.channels` / `message.groups` ne sont toujours pas abonnés** dans la console Slack.
   Tant qu'ils ne le sont pas, la base de connaissance ne se remplit que par les DM. C'est un
   geste humain, pas un correctif.
4. **Le taux de faux négatifs du détecteur d'injection est inconnu.** On sait ce qu'il attrape ;
   on ne sait pas ce qu'il laisse passer.
5. **Deux politiques de sortie opposées pour la même menace** : Slack retire l'URL et garde le
   message ; l'email d'entretien REFUSE le lien. C'est délibéré — un message Slack amputé reste
   utile, un email qui convoque « à [lien retiré] » est activement nuisible — mais deux politiques
   pour une menace sont deux occasions de se tromper.
6. **Aucune donnée de candidat n'est persistée** : `RecipientType` n'a pas de valeur honnête pour
   un non-salarié, et en ajouter une créerait des données personnelles sans chemin d'effacement.
   La trace vit dans le fil Slack et dans les logs.
7. **`data/kisso.db` locale et les migrations `drizzle/` sont désynchronisées de `schema.ts`.**
   Appliquer `drizzle/` sur une base vierge échoue. Le schéma de production a été appliqué par DDL
   exporté, jamais par le migrateur.
8. **Node tourne en v20.19.4** alors que `engines` exige `>=22.13.0`.
9. **`CLAUDE.md`, `CHANGELOG.md` et `TODO.md` ne sont pas versionnés** — `.gitignore` porte
   `/*.md`, et `README.md` est la seule exception. Les trois documents qui portent le plus de
   contexte de travail n'ont aucun historique.
10. **Aucune métrique, aucune trace distribuée.** Les logs bruts et des sondes écrites à la main
    tiennent ce rôle. Cela ne suffit que parce que le volume est faible et que quelqu'un lit
    chaque log.

---

## 13. Où lire la suite

| Document | Ce qu'il répond |
| --- | --- |
| `CLAUDE.md` | comment travailler dans ce dépôt, et les pièges |
| `docs/journal/` | **le parcours JOUR PAR JOUR** — constaté / envisagé / retenu / livré |
| `docs/recapitulatif-projet.html` | le même parcours par THÈME |
| `docs/harness-engineering.html` | ce que le harness utilise, ce qu'il omet, et pourquoi |
| `docs/tool-design-audit.md` | le même exercice pour les OUTILS |
| `docs/notions-agentiques.html` | les notions, hors du temps |
| `docs/conception/` | le POURQUOI du code, une page par feature |
| `docs/adr/` | les décisions d'architecture — **ne jamais en modifier une, en créer une nouvelle** |
| `AUDIT_REPORT.md` §8 | la liste des points ouverts, par priorité |

---

## 14. La leçon, s'il n'en fallait qu'une

*Ce que ce dépôt DÉRIVE est juste ; ce qu'il RECOPIE a dérivé.* Sans exception trouvée sur
onze affirmations fausses recensées — **onze étaient dans la documentation à distance, aucune dans
un commentaire adjacent au code**.

C'est vrai des listes, des chaînes de modèles, des invariants, des chiffres — et de ce document.
**Avant de croire un nombre écrit ici, le recompter.**
