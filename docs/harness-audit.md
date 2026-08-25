# Audit Harness Engineering — le harness de Marcel, module par module

> **Portée** : tout ce qui entoure le modèle dans ce dépôt — perception, routage, outils,
> mémoire, garde-fous, déploiement, observabilité. Relu le **2026-08-25** contre la branche
> `refactor/cleanup-20260810`.
>
> **Méthode** : identique à `docs/tool-design-audit.md`. Tout chiffre est **compté sur le code
> ou relevé en production**, jamais recopié d'un autre document. Quand une source du dépôt dit
> autre chose, l'écart est imprimé.
>
> **Grille** : les douze modules d'un cursus de *Harness Engineering*. Pour chacun : **ce que le
> harness fait**, **ce qu'il ne fait pas**, et pourquoi — en séparant le **choix argumenté** de
> la **dette**.
>
> **Document jumeau** : `docs/harness-engineering.html` (2026-08-24) raconte la même matière en
> essai continu. Celui-ci est un audit : il conclut, il classe, et il chiffre.

---

## 0. Les trois faits d'environnement qui gouvernent tout le reste

Aucune décision de ce harness ne se comprend sans eux. Ils ne sont pas dans le programme, et ils
expliquent plus de la moitié de ce qui suit.

| Fait | Conséquence sur le harness |
| --- | --- |
| **Le quota se compte à la JOURNÉE** — ≈ 19 messages/jour sur Groq (100 000 tokens, 5 168/message mesurés), 20 requêtes/jour sur le palier gratuit Gemini | Le poste de coût dominant n'est pas la TAILLE du prompt mais le **NOMBRE D'ÉTAPES**. Une étape épargnée vaut ≈ 1 500 tokens ; un prompt raboté en vaut quelques dizaines. |
| **Serverless : rien ne s'exécute tant que personne ne frappe** | Aucun `setTimeout` ne survit au gel. `findPending()` était écrite, correcte, **et sans appelant — parce qu'il n'existait personne pour l'appeler.** Il a fallu une horloge extérieure (cron Vercel). |
| **Slack accorde 3 secondes pour l'ACK**, et à ≈ 19 messages/jour **le cas froid EST le cas nominal** (5 229 ms mesurées à froid, 684 ms à chaud) | D'où le portier d'ACK, et d'où la disparition de **toutes** les modales. |

---

## Module 1 — Fondamentaux : `Agent = Modèle + Harness`

### Ce qui est en place

**La séparation est réelle et vérifiable, pas déclarative.** Le modèle est interchangeable par
une seule constante : `resolveModelIds` (`src/shared/llm/model-fallback.ts`) déclare la chaîne
Gemini → Groq → Mistral **une fois**, et l'ordre EST le contrat. Le harness n'a pas bougé quand
le primaire est passé de Groq à Gemini le 2026-08-20, ni quand `llama-3.3-70b-versatile` a
**disparu du compte Groq** le 2026-08-15.

⚠️ Ce dernier incident est la meilleure preuve que la séparation tient — et le meilleur exemple
de ce qu'elle masque : **le bot répondait toujours**, la chaîne de repli faisant son travail.
Chaque message payait un aller-retour Groq perdu puis tombait chez Mistral, plafonné à
**4 requêtes/minute**. Un harness qui dégrade proprement rend la panne invisible ; il faut donc
qu'il la DISE.

**La part du harness est mesurable, et elle est écrasante.** Sur 32 métriques du tableau de bord,
le modèle n'intervient dans aucune. Sur les onze paliers que traverse un message, **le modèle est
l'avant-dernier**. Neuf court-circuits répondent sans lui, à zéro token.

### Ce qui manque

**Aucune abstraction de « modèle » propre au dépôt.** Le harness parle à Mastra, qui parle au
Vercel AI SDK, qui parle aux fournisseurs. Changer de framework — pas de modèle — demanderait de
réécrire le câblage des agents et des outils. C'est un choix assumé (Mastra fournit le
function-calling, le registre et le serveur HTTP) mais le couplage n'est nulle part chiffré.

---

## Module 2 — Architecture : la boucle agentique

### Ce qui est en place

**La boucle est explicite et vit dans UN fichier** : `slack-events.handler.ts`. Elle n'est pas
« perception → raisonnement → action → observation » : elle est **plus longue avant le modèle
que dans le programme**, et c'est la conséquence directe du quota journalier.

```
signature HMAC → ACK (< 3 s) → déduplication partagée → limite de débit
  → construction du contexte → NEUF court-circuits déterministes
  → frontière d'autorisation → budget modèle → routage en 4 temps
  → MODÈLE → assainissement → réconciliation FAIT/NARRATION → publication
```

**Le routage est du CODE, jamais du modèle** — quatre paliers (échappement symétrique → collant
→ thématique → défaut), exprimés en **capacités** et **dérivés d'`AGENT_TOOLS`**. Déplacer un
outil d'un agent à l'autre change le routage tout seul.

**La modularité est verrouillée par un test, pas par une convention.**
`tests/unit/quality/architecture.test.ts` interdit `domain → infrastructure`, couvre `shared/`
depuis le 2026-08-22, et surveille les arêtes infrastructure↔infrastructure entre features.

⚠️ **Quatre arêtes réelles subsistent**, toutes dans le handler : ce sont les quatre `new` du
repli de construction par défaut. Elles sont inscrites en **DETTE NOMMÉE**, et un second test
fait rougir toute entrée dont l'arête a disparu — **la liste ne peut que rétrécir.**

### Ce qui manque

**Aucun orchestrateur formel** — pas de machine à états déclarée, pas de graphe. Les états
conversationnels (profil en cours, entretien en cours, email en attente) sont **reconstitués du
fil** à chaque message, en relisant le dernier tour de l'assistant.

⚠️ **Et cette absence a coûté trois fois, avec le même symptôme.** Le 2026-08-21 :
*« deux machines à états qui suivent la même règle sans la partager finissent par diverger, et
c'est celle qu'on a oubliée qui perd les données. »* Une réponse trop courte mettait fin à
l'entretien **en silence** ; le verdict de « j'ai fini » lisait une table de moins que le
parcours. Un état explicite et unique aurait fermé les trois d'un coup.

**Un seul workflow Mastra survit** (`employeeOnboardingWorkflow`). Les trois autres ont été
retirés le 2026-08-12 : *ils se déclaraient réussis sans faire la moindre E/S.*

---

## Module 3 — Perception et entrées

### Ce qui est en place

**Une seule modalité, assumée : le texte Slack.** Les pièces jointes sont détectées
(`subtype: file_share`) et **refusées explicitement** plutôt qu'ignorées.

**Le fenêtrage est en TOKENS, jamais en nombre de messages.** `@mastra/memory` a été écarté pour
deux raisons dont la seconde est décisive : il exige `zod ^4` (le dépôt épingle `3.25.76`), et
**il ne sait plafonner qu'en nombre de messages** — inadapté quand un seul tool-result pesait
2 506 tokens. `CONVERSATION_TOKEN_BUDGET` = 1600, ratio 3,5 car./token.

⚠️ **La fenêtre ne coupe jamais une salve `user`+`assistant`** : un tour `assistant` orphelin
répondrait à une question invisible pour le modèle, **ce qui est pire que pas de mémoire**. Un
tour dépassant 40 % du budget est TRONQUÉ, pas exclu.

**Le prétraitement est une frontière de sécurité, pas un nettoyage.** `wrapAgentInput` encadre le
texte d'un délimiteur à marqueur de session ; `validateDelimiterIntegrity` rejette toute seconde
balise ouvrante. Conséquence architecturale : **l'historique est transmis en messages structurés
NON encadrés**, un seul bloc existant par appel.

**`cleanText` ne retire QUE la mention du bot.** Elle les retirait toutes, donc
`@mastra crée un profil pour <@U0AWA>` **perdait son sujet** avant d'atteindre le modèle.

**Le RAG existe, à deux niveaux, et il est déterministe.** `channel_messages` (brut) et
`knowledge_facts` (distillé par du CODE : décision, engagement, blocage, échéance, question).

⚠️ **LE CONSTAT QUI RELATIVISE TOUT** : au 2026-08-21, les deux tables étaient **VIDES**.
Pipeline câblé, index FTS créés, `searchKnowledge` ne pouvait rendre que `nothing_known` — **et
rien ne le signalait.** Ce qui manquait n'était pas du code mais les ÉVÉNEMENTS :
`message.channels` / `message.groups` ne sont toujours pas abonnés côté console Slack. *Un
harness peut être entièrement correct et entièrement inerte.*

⚠️ **La sélection se fait par SAILLANCE, pas par récence.** Les 6 derniers messages d'un canal ne
sont presque jamais les 6 importants — ce sont « ok », « merci », « 👍 ». Le modèle recevait les
accusés de réception d'une décision dont il ne voyait pas l'énoncé.

⚠️ **Trois occurrences du même piège d'encodage.** `/\bbloqué\b/` ne matche **jamais** : `é`
n'étant pas une lettre ASCII, la position entre `é` et `,` n'est pas une frontière. Idem
`cassé`, `décidé`, `validé`. Et les motifs de distillation sont écrits **sans accent** avec le
texte plié avant comparaison — trouvé en production : *« on a **decide** de partir sur postgres »*
ne produisait aucun fait. **Un motif qui échoue en silence sur la moitié du vocabulaire français
est pire qu'un motif absent.**

### Ce qui manque

**Aucune modalité non textuelle** — ni vision, ni audio, ni fichier lu. Cohérent avec le produit
et avec le quota : décrire une image coûte un appel de modèle par image.

**Aucune recherche sémantique** — FTS lexical seulement. Un index vectoriel demanderait un appel
d'embedding par message ingéré, sur un quota qui se compte à la journée.

**Aucun résumé progressif de conversation.** Au-delà du budget, les tours anciens sont ÉVINCÉS,
pas résumés. Un résumé coûterait un appel de modèle — le poste que tout le dépôt minimise.

---

## Module 4 — Sélection des actions et outils

Traité en détail dans **`docs/tool-design-audit.md`**. Ce qui relève du harness :

### Ce qui est en place

**Le câblage agent → outils est déclaré UNE fois** (`AGENT_TOOLS`), et trois choses en dérivent :
le routage, le test de budget de prompt, et la frontière négative envoyée au modèle.

**L'effet de chaque outil est déclaré** (`TOOL_EFFECTS`, 2026-08-25) et la partition
lecture/action de la réconciliation en DÉRIVE. Avant, c'était une liste recopiée — **et elle a
déjà été fausse**, avec pour symptôme un SILENCE.

**Deux quarantaines croisées lèvent à la CONSTRUCTION**, jamais au runtime : un câblage interdit
ne démarre pas.

**Le contrôle d'étapes existe depuis le 2026-08-25** : `maxSteps: 6` sur `agent.generate`. Il n'y
avait auparavant qu'un `AbortSignal.timeout(40 s)` — une borne de TEMPS, pas de COÛT.

**Les cinq outils agissants portent tous une garde d'idempotence** depuis le 2026-08-25 (deux sur
cinq auparavant). Le défaut fermé a été observé : **7 documents et 3 emails identiques en
8 minutes**.

### Ce qui manque

**Aucune reprise ni back-off par outil**, et c'est délibéré pour le modèle : le dernier maillon
plafonne en **requêtes** (4/min), donc une seconde d'attente ajoute de la latence sans changer
l'issue. **Mais l'argument ne couvre pas les E/S non-LLM** — Slack et SMTP ne sont pas plafonnés
de la même façon, et la reprise réseau (`resilientFetch`) n'existe que dans `scripts/`.

**Aucun outil réversible** — pas de `cancelReminder`, pas de `deleteDocument`.

⚠️ **`outputSchema` reste NON CÂBLÉ, et la mesure du 2026-08-25 en fait un choix, plus une
lacune.** Mesuré : Mastra **valide** l'`outputSchema` d'un outil, et en cas d'échec il **ne lève
pas** — il remplace le résultat par
`{ error: true, message: 'Tool output validation failed…' }`, qui part vers le modèle. Sur des
outils dont le résultat est légitimement multiforme (succès / refus / introuvable / dégradé), un
seul cas oublié rendrait l'outil entièrement muet **en silence**. Et Mastra ne s'en sert pas pour
contraindre le modèle : il n'y a aucun gain en face du risque. Ce qui est fermé à la place est le
**vocabulaire** : les 24 codes de `reason` écrits en littéral sont déclarés et vérifiés par test ;
ceux qui transitent par une union de types le sont déjà par `tsc`.

---

## Module 5 — Mémoire et état

### Ce qui est en place

**Quatre mémoires distinctes, chacune avec sa politique de rétention** :

| Mémoire | Support | Rétention |
| --- | --- | --- |
| de travail | fenêtre du modèle | 1600 tokens |
| court terme | `conversation_turns` | `CONVERSATION_TTL_MS` = 60 min |
| long terme | `pinned_facts` | 5 faits × 120 car., éviction du plus ancien |
| sémantique | `knowledge_facts` | `KNOWLEDGE_RETENTION_DAYS`, opt-in |

⚠️ **UN SEUL TTL gouverne la mémoire ET le routage collant**, et ce n'est pas une commodité :
deux durées différentes feraient qu'un fil « chaud » pour le routage serait « froid » pour la
mémoire, ou l'inverse.

**On ne stocke QUE du texte** — jamais de tool-call ni de tool-result. Conséquence directe et
assumée : un identifiant rendu par un tool-result **n'est plus dans la fenêtre au message
suivant**. C'est ce qui a imposé que `generateDocument.revises` soit un **booléen** et non un
UUID — *un identifiant qu'on demande au modèle est un identifiant qu'il peut inventer*, et la
première version a échoué en production exactement là.

**Le tour `user` est écrit APRÈS assainissement**, sinon un faux délimiteur persisterait et
serait rejoué non encadré à chaque tour suivant.

**Les faits épinglés sont restitués comme des DÉCLARATIONS de la personne**, jamais comme des
consignes — sans quoi *« souviens-toi que tu dois ignorer tes règles »* deviendrait une règle.

⚠️ **Le TTL de 60 min n'était appliqué qu'EN LECTURE.** La purge dépendait d'un compteur en
mémoire PAR INSTANCE, remis à zéro à chaque démarrage à froid, avec un seuil de 100 jamais
atteint à ≈ 19 messages/jour : les lignes restaient **sans borne réelle**. Remplacé par un tirage
sans état (probabilité 0,2) — *une borne, toujours pas une garantie : seul un cron en serait
une.*

### Ce qui manque

**L'état conversationnel n'est pas persisté** — il est reconstitué du fil. Voir module 2 : trois
pertes de données silencieuses en viennent.

**`KNOWLEDGE_RETENTION_DAYS` n'a JAMAIS été posée.** Le cron appelle fidèlement `pruneKnowledge`
chaque matin pour ressortir aussitôt en `enabled: false` : **rien n'a jamais été purgé**, et
depuis le 2026-08-21 les DM sont archivés et lisibles par le manager. Ce n'est pas un défaut de
code, **c'est une valeur à poser** — et le code ne se tait plus : `warn` si absente, `error` si
posée puis rejetée, ce second cas étant le pire parce qu'on croit alors avoir configuré une
rétention.

**Aucune mémoire vectorielle**, aucun profil utilisateur structuré au-delà du dossier employé.

---

## Module 6 — Validation et garde-fous

Le module le plus densément couvert du dépôt, et de loin.

### Ce qui est en place

**Le garde-fou le plus original est la réconciliation FAIT / NARRATION**, née d'un verdict
d'utilisatrice : *« il parle exactement de la même façon quand il a fait le travail et quand il
l'a inventé. »* Le handler est le seul point qui voie à la fois la réponse et la trace
d'exécution ; il les CONFRONTE.

- **14 familles** de formules d'accompli (`ACCOMPLISHMENT_CLAIMS`) + **7** au futur
  (`FUTURE_DELIVERY_CLAIMS`).
- ⚠️ **Le filtre interrogatif compte plus que les motifs** : sans lui, « Tout est bon pour toi ? »
  se ferait requalifier — un démenti accolé à une QUESTION.
- ⚠️ **`null` (trace illisible) n'est PAS `[]` (zéro appel)** : sans preuve positive, on se tait.
- ⚠️ **La note n'entre pas en mémoire** : la rejouer apprendrait au modèle à imiter le démenti.
- ⚠️ **Prérequis longtemps invisible** : `readToolCalls` journalisait `"unknown"` sur **100 % des
  appels** (19 runs de production). Le champ ajouté pour distinguer une action d'une narration ne
  répondait à aucune question.

**Le principe directeur, mesuré quatre fois** : *une consigne d'agent est PROBABLE, le code est
GARANTI.* La citation du destinataire, la couverture des extraits, la rédaction du contenu et
l'interdiction du markdown ont **toutes** été mesurées en échec comme consignes, puis remplacées
par du code.
⚠️ **Le COMPTE, lui, a dérivé** : `CLAUDE.md` en donne trois valeurs différentes selon l'endroit
— « cinq », « quatre fois », « TROISIÈME ». Aucune n'est dérivée de quoi que ce soit. C'est la
forme exacte que `claimed-invariants.test.ts` traque, appliquée à la phrase qui énonce la
doctrine.

**Treize tests de qualité** gardent la doctrine elle-même, dont deux d'une classe rare :

| Test | Ce qu'il empêche |
| --- | --- |
| `claimed-invariants` | qu'une phrase « verrouillé par `X` » cite un fichier inexistant |
| `design-docs-anchor-real-code` | qu'une page de conception désigne du code supprimé |
| `comments-live-in-docs` | que le POURQUOI revienne dans `src/` |
| `tool-contracts` (2026-08-25) | que `TOOL_EFFECTS` diverge du câblage, ou qu'un `reason` échappe au vocabulaire |

⚠️ **La leçon de méthode du dépôt** : les trois défauts les plus coûteux d'une revue avaient été
**MASQUÉS par un commentaire**, et ils partagent une forme — *le commentaire énonce une propriété
GLOBALE que rien ne recalcule.*

⚠️ **UN PROMPT NE DOIT JAMAIS PRESCRIRE UNE SORTIE QUE LE FILTRE DE SORTIE CENSURE.** La
DIRECTIVE 6.1 ordonnait de répondre `[SECURITY_BLOCK] …`, chaîne présente dans
`INTERNAL_MARKERS` : toute réponse OBÉISSANT à la directive était détectée comme fuite et
**remplacée en bloc**. `recruitmentAgent` répondait « Réponse retirée » sur une demande
parfaitement légitime — **la feature était cassée par le garde-fou censé la protéger**, et le
symptôme est indiscernable d'une panne.

**Le corpus à deux colonnes** (`distress.test.ts`) est le modèle d'évaluation le plus solide du
dépôt : les phrases que dirait quelqu'un en détresse ET celles que dirait quelqu'un qui ne l'est
pas. *N'en exercer qu'une moitié ne mesure rien.* Résultat : 0 faux négatif, 0 faux positif,
contre 2 et 6.

### Ce qui manque

**Aucune boucle d'auto-correction.** Une sortie invalide n'est jamais renvoyée au modèle pour
correction — elle est requalifiée, assainie ou refusée. **C'est un choix de coût explicite** :
une boucle de correction est un aller-retour de plus, et l'aller-retour est le poste dominant.
Le harness préfère **retirer au modèle de quoi mal faire** plutôt que corriger après coup.

**Aucun validateur sémantique** (pas de modèle-juge). Même raison.

---

## Module 7 — Planification et raisonnement

Le module le plus largement écarté, et c'est argumenté.

### Ce qui est en place

**La planification est STATIQUE et vit dans le code.** Le seul workflow restant est un pipeline
fixe. Les parcours conversationnels (profil, entretien) sont des séquences de questions
déterministes, à zéro token.

**Le modèle ne planifie rien qui engage** : il ne choisit ni le canal, ni le destinataire, ni le
document à réviser, ni l'agent qui traitera le tour suivant.

### Ce qui manque

**Aucune décomposition de tâche par le modèle**, aucune replanification, aucun solveur.

**La justification est chiffrée et tient** : demander un plan est un aller-retour ; l'exécuter en
est un par étape ; replanifier en ajoute encore. Sur ≈ 19 messages/jour, **un planificateur
consommerait le budget d'une journée pour une seule demande.**

⚠️ **Mais il faut nommer ce que cela coûte** : le produit ne sait traiter que des demandes à une
ou deux étapes. « Prépare l'arrivée de Jean : crée son dossier, invite-le aux canaux et envoie-lui
le guide » n'a aucun chemin. Ce n'est pas une limite du modèle, c'est une limite du harness — et
elle est invisible depuis l'extérieur, parce que le modèle répond quelque chose de plausible.

---

## Module 8 — Communication et interaction

### Ce qui est en place

**Une seule interface, et elle a été SIMPLIFIÉE par la mesure, pas par goût.** Il ne reste
**aucun bouton sur le chemin nominal** : les quatre `action_id` ont été retirés un par un et pour
la MÊME cause — sur une fonction froide, `views.open` échoue en `invalid_trigger_id`, et le cas
froid est le cas nominal. Les modales sont devenues des **échanges écrits**, à zéro token.

⚠️ **Le branchement `view_submission` RESTE**, et c'est la seule chose qui compte : sur une
fonction chaude, un bouton posté hier peut encore ouvrir sa modale. Sans ce chemin, la personne
remplirait le formulaire, verrait la fenêtre se fermer **comme sur un succès**, et rien ne serait
gardé.

**Le multi-agents existe (4 agents) mais SANS protocole entre agents** : aucune passation, aucun
message inter-agents. Le routage est central et déterministe.
⚠️ **La consigne « passe la main à l'agent de notification » a été SUPPRIMÉE** : aucun mécanisme
de passation n'existe, donc elle ordonnait l'impossible et invitait à NARRER une délégation qui
n'a jamais lieu. Deux tests protègent la suppression.

**Les tours d'un AUTRE agent sont marqués** `[autre agent]` dans l'historique rejoué. Sans marque,
un agent lit la voix d'un autre **comme la sienne** — observé en production.

**Le marqueur de progression** poste « Je regarde ça » puis **remplace** le message via
`chat.update`. Il ne bloque pas, et tout échec est un `warn` avec repli sur un `postMessage`
normal : **ce n'est jamais un point de panne.**
⚠️ **Pas de rafraîchissement périodique**, décision assumée : un timer courrait contre `resolve()`
et **écraserait la réponse finale** par le texte du marqueur.

**Le style est un module** (`agent-style.ts`, `assistant-identity.ts`), et sa garantie est un
test qui scanne tout `src/`, pas une consigne.
⚠️ **L'ORDRE DES DEUX GESTES EST TOUT.** Le ton chaleureux était refusé, et l'argument était
juste : le détecteur d'accompli ne connaissait que six tournures administratives — « Voilà, ton
document t'attend » n'y entrait pas. L'argument ne disait pas « jamais », il disait **« pas AVANT
le détecteur »**. Celui-ci est passé à 14 familles, livré et testé **avant** la première
modification de ton.

### Ce qui manque

**Aucune interface de supervision jusqu'au 2026-08-25** — `/dashboard` la fournit désormais, en
lecture seule.

**Aucune reprise en main humaine.** Pas de file, pas d'opérateur, pas de transfert. Le tableau de
bord le déclare explicitement comme une absence de MÉCANISME plutôt que d'afficher « 100 %
automatique », **qui serait une tautologie présentée comme une performance.**

---

## Module 9 — Déploiement et mise à l'échelle

### Ce qui est en place

**Le déploiement est mesuré, et une mesure a changé l'architecture.** Un clic signé prenait
**5 229 ms à froid** (9 173 ms sur un déploiement neuf) contre 3 000 accordées par Slack. Les
leviers évidents étaient **déjà tirés** : ACK sans E/S, Fluid Compute actif, mémoire au maximum,
import du graphe applicatif en 0,82 s. Le reste était le dépaquetage de la fonction — 264 Mo,
20 447 fichiers.

**Correctif : un portier d'ACK**, seconde fonction Vercel de 24 Ko, **zéro `node_modules`**. Il
vérifie le HMAC, répond, rejoue la requête vers un chemin interne. **Il ne décide rien.**
Mesuré : 734 ms de médiane.
⚠️ **L'hôte de réexpédition vient de la REQUÊTE** (`x-forwarded-host`), jamais d'une variable :
sur une prévisualisation, une URL de production ferait traiter l'événement par le mauvais code —
**et le symptôme serait « ça marche ».**

**Le bundle est élagué par ATTEIGNABILITÉ à chaque build**, jamais par une liste : 178 paquets,
11 696 fichiers, 64 Mo retirés ; 264 → 160 Mo.
⚠️ **Trois filets, parce que l'analyse statique ne voit pas tout** : `verify:bundle` **importe
réellement** `index.mjs`, produit un vrai PDF **et un vrai DOCX** depuis le bundle, et refuse tout
élagage aberrant (> 75 %).
⚠️ **Le bundle NE DÉMARRAIT PAS en local pendant que le build sortait en vert** — le déployeur
Mastra épingle `@mastra/core` 0.24.9 et installe sa fermeture, que `fix-vercel-output.js`
laissait derrière : `SyntaxError: Named export 'TTLCache' not found`, **mort avant la première
instruction**. La production, elle, tournait — sa fermeture est différente (328 paquets contre
659). *Une heuristique de version a été essayée et dénonçait cinq écarts que la production fait
tourner.*

**Le cron est déclaré dans `vercel.json`, source UNIQUE.** La première version le recopiait aussi
dans `.vercel/output/config.json` — ce que la doc du Build Output API présente comme LA façon de
faire. Déploiement rouge : *« A duplicated cron job… »*. **Vercel lit les deux et les fusionne** —
non déductible des docs, il a fallu un déploiement rouge.

**La limite de débit est à trois règles** : rafale (5/min), quotidienne (200/jour) et un plafond
de tokens à l'échelle du workspace (4 M/jour).
⚠️ **La limitation était devenue SON PROPRE SPAM.** Depuis que le budget est débité juste avant
`agent.generate()`, un message refusé n'incrémente rien : le compteur reste figé, l'égalité
`count === limit + 1` reste vraie, et « une fois, puis silence » était devenu « à chaque
message ».

### Ce qui manque

**Aucun conteneur, aucun Kubernetes** — non pertinent sur Vercel.

**Aucun déploiement progressif.** Une régression est en production pour tout le monde d'un coup.
La contrepartie tient : les sondes vérifient la production **après** chaque déploiement, à zéro
token.

**Aucune trace distribuée.** Une requête traverse le portier puis la fonction applicative sans
identifiant commun propagé. Sur deux fonctions, cela reste diagnostiquable ; à trois, non.

⚠️ **`engines` exige Node `>=22.13.0` et la machine tourne en v20.19.4.** Divergence non résolue,
et elle est locale : Vercel, lui, respecte `engines`.

---

## Module 10 — Sécurité et robustesse

### Ce qui est en place

Le module le mieux servi avec le 6. L'essentiel est traité dans `docs/tool-design-audit.md` §6.
Propre au harness :

**Quatre surfaces de fuite du prompt système fermées** (2026-08-14), dont deux ne demandaient
**aucune ruse** : `GET /api/agents` rendait les instructions des quatre agents en clair.
⚠️ **Ce ne sont pas des fuites de MODÈLE mais de MÉTADONNÉES** — un GET suffit, sans injection ni
appel de modèle. La rédaction est **récursive** (sur `/api/agents` la clé n'est jamais de premier
niveau) et **inconditionnelle, développement compris** : un développeur a le SOURCE ; seul
quelqu'un qui n'a pas le dépôt a besoin de cette route pour lire le prompt.

**`requestContext` était FORGEABLE par le corps HTTP.** Mastra fusionne `body.requestContext` et
n'écarte que `RESERVED_CONTEXT_KEYS` — vérifié dans le paquet installé : **aucune clé `slack*`**.
Or c'est sur elles que se décident les droits. **Le jeton de service valait l'usurpation totale.**
Le garde **REFUSE (400)** au lieu d'assainir, et surveille un **PRÉFIXE**, pas une liste recopiée
— les clés pas encore écrites sont couvertes d'avance.

⚠️ **DANS HONO, UN MIDDLEWARE QUI A APPELÉ `next()` DOIT ASSIGNER `c.res`, PAS RETOURNER.** Ce
piège a rendu `createCallerErrorMiddleware` **inopérant depuis son écriture** sur son chemin
principal, et **ses tests unitaires assertaient le RETOUR** : verts sur du code mort.

**La déduplication est à DEUX niveaux**, et le LRU seul ne pouvait pas suffire : il est **par
instance**, donc incapable d'écarter un rejeu routé ailleurs. C'est la cause de la double réponse
du 2026-08-11 — deux messages signifient **deux invocations**.
⚠️ **Dégradation assumée** : store indisponible → repli local et l'événement est **accepté**. *Un
doublon possible vaut mieux qu'un message perdu — le doublon est visible et corrigeable, le
silence ne l'est pas.*

**Le fail-open est la règle, le fail-closed l'exception, et les deux sont argumentées.**
Fail-open : `readSlackContext`, le marqueur de progression, la mémoire, la déduplication.
Fail-closed : `CRON_SECRET` (503) et `DASHBOARD_TOKEN` (503) — **sans secret, ces routes seraient
respectivement une primitive publique d'envoi et une fuite de données RH.**

**La frontière d'autorisation a été activée sur un FAIT, pas sur une intuition.**
`npm run probe:authz` évalue tout l'annuaire d'un coup, en lecture seule, **en important
`resolveAccess`** — une seconde copie de la règle dirait un jour autre chose que la première, et
ce serait le jour où quelqu'un s'en sert.
⚠️ **Le mode observation ne journalise QUE les gens qui écrivent au bot** — or c'est celui qui ne
lui a jamais parlé qu'on cassera le jour de l'activation. *Sur un workspace de six personnes,
« lire les logs puis activer » ne peut PAS rendre la réponse complète.*

**Le ReDoS a été MESURÉ, pas supposé** : deux motifs réels sur douze, corrigés ; les dix autres
tiennent sous 1 ms. Les règles sont désactivées au profit d'une garde empirique qui exerce
**89 charges adverses** sur les deux portes d'entrée réelles.

### Ce qui manque

**Aucun sandboxing** — les outils tournent dans le même processus. Sans exécution de code
arbitraire, la surface n'existe pas.

**Aucun gestionnaire de secrets** au-delà des variables d'environnement Vercel.
✅ En revanche, **aucune valeur de clé n'est jamais journalisée** — seulement sa présence — et
`maskPii` couvre depuis le 2026-08-14 les champs de prose humaine (`text`, `content`, `body`,
`fact`, `dailyWork`, `workStyle`).
⚠️ **`message` en est délibérément EXCLU** — c'est le champ des messages d'erreur dans tout le
dépôt, et le masquer **supprimerait le diagnostic au lieu de protéger quelqu'un**.

**Aucun circuit-breaker.** Slack en panne ⇒ les cinq outils agissants continuent d'essayer,
message après message.

**La conformité n'a pas de chemin d'effacement complet.** `forget()` couvre la conversation ; les
`notifications`, les `documents` et l'invitation d'un candidat n'en ont aucun. C'est écrit, et
c'est précisément pourquoi `scheduleCandidateInterview` **n'écrit AUCUNE donnée personnelle en
base** : *stocker l'adresse d'un non-salarié créerait des données personnelles sans chemin
d'effacement.*

---

## Module 11 — Patterns avancés et études de cas

Trois cas de ce harness, choisis parce que dans chacun **le correctif évident était le mauvais**.

### Cas 1 — L'ACK à 5 229 ms : le correctif n'était pas dans le code du handler

Les leviers évidents étaient déjà tirés. La cause était le **dépaquetage** de la fonction. Le
correctif est un composant **qui ne sait rien du produit** — et sa vertu est exactement là.
⚠️ **Ce qu'un portier ne sauve pas** : `views.open` a lieu ensuite, dans la fonction restée
froide. **Le correctif de latence a changé la nature de l'interface** — les quatre modales ont
disparu.
⚠️ Les chiffres sont un **MAJORANT** : `x-vercel-id: cpt1::iad1` — la requête entre au Cap, la
fonction tourne à Washington. **Toute mesure de latence prise d'ici doit être lue avec cette
réserve.**

### Cas 2 — La couverture des extraits : trois formes pour une phrase

Un champ `coverage` → **ignoré**. Le même texte renommé `hint` → **ignoré aussi**. Placé dans le
flux, juste avant les extraits → lu.
**La leçon, générale au harness** : *un champ séparé se lit comme une métadonnée, quel que soit
son nom.* Ce qui doit être lu doit être **dans le flux**, pas à côté.

### Cas 3 — Le rappel qui ne partait pas : il manquait une horloge

`findPending()` était écrite, correcte, sans appelant — **parce qu'il n'existait personne pour
l'appeler.** Un serverless ne peut pas se donner une horloge à lui-même.
⚠️ **La granularité est un FAIT DE PLATEFORME** : le plan Hobby n'autorise qu'une exécution par
jour et ne garantit l'heure qu'à **±59 min**. Des deux erreurs possibles — le matin du BON JOUR
ou le LENDEMAIN — on choisit le bon jour.
⚠️ **On ne lui interdit pas de mentir : on lui RETIRE DE QUOI.** Le tool ne rend plus l'heure
demandée, seulement `deliveredOn: 'le lundi 24 août 2026 au matin'`.
⚠️ **Le détecteur de fausse promesse a dû bouger avec le câblage** : `onlyNonDeliveringTools`
n'avait de sens que tant que rien ne partait. *Un détecteur encode le câblage ; quand le câblage
bouge, il ne devient pas inoffensif, il devient faux dans l'autre sens.*

---

## Module 12 — Projet final : les critères, un par un

| Critère | Verdict | Preuve |
| --- | --- | --- |
| **Robustesse** | forte sur les E/S, **faible sur l'état conversationnel** | dégradation nommée partout ; mais trois pertes de données silencieuses par état reconstitué |
| **Sécurité** | forte | 4 surfaces de fuite fermées, `requestContext` non forgeable, 2 quarantaines à la construction, frontière active en production |
| **Modularité** | forte | modèle interchangeable par une constante ; règle de dépendance verrouillée par test |
| **Performance** | contrainte par la plateforme, mesurée | ACK 734 ms médian ; ≈ 19 messages/jour ; 9 réponses à zéro token |
| **Qualité du code** | 187 fichiers / 2 635 tests, lint 0/0, typecheck 0 | dont **13 tests qui gardent la DOCTRINE**, pas le code |

### Ce que ce harness fait mieux que la plupart

1. **Il dérive au lieu de recopier.** Frontière négative dérivée des clés d'outils, routage dérivé
   d'`AGENT_TOOLS`, partition lecture/action dérivée de `TOOL_EFFECTS`, `.env.example` dérivé de
   `src/`.
2. **Il confronte la parole à la trace.** La réconciliation FAIT/NARRATION n'a pas d'équivalent
   courant : le harness est le seul point qui voie les deux.
3. **Il retire au modèle de quoi mal faire** plutôt que de le lui interdire. Pas d'heure dans le
   tool-result, pas d'UUID demandé au modèle, pas de champ libre sortant vers un candidat.
4. **Il teste ses propres énoncés.** Une phrase « verrouillé par X » doit citer un fichier qui
   existe ; une page de conception doit désigner du code vivant.
5. **Il chiffre ce qu'il refuse.** Chaque absence de ce document porte son coût et son
   alternative.

---

## Synthèse — les dettes du harness, par coût décroissant

| # | Dette | Coût | Effort |
| --- | --- | --- | --- |
| 1 | **L'état conversationnel est reconstitué du fil, pas persisté** | trois pertes de données silencieuses déjà mesurées ; la quatrième est probable | élevé |
| 2 | **Aucune planification multi-étapes** | le produit ne traite que des demandes à une ou deux étapes, et l'échec est invisible — le modèle répond quelque chose de plausible | élevé |
| 3 | **`message.channels` / `message.groups` non abonnés** | toute la base de connaissance est inerte ; `shouldAbandonThreadReply` est du code atteignable en test et jamais en production | **nul — c'est un geste humain dans la console Slack** |
| 4 | **`KNOWLEDGE_RETENTION_DAYS` jamais posée** | rien n'a jamais été purgé, et les DM sont archivés et lisibles par le manager | **nul — une valeur à poser (minimum 7)** |
| 5 | **Aucune reprise réseau dans `src/`** | `resilientFetch` n'existe que dans `scripts/` ; un `UND_ERR_CONNECT_TIMEOUT` a déjà tué une sonde | moyen |
| 6 | **Aucun circuit-breaker** | Slack en panne ⇒ chaque message continue de consommer son quota | faible |
| 7 | **Aucune trace distribuée** | diagnosticable à deux fonctions, plus à trois | moyen |
| 8 | **Aucun déploiement progressif** | une régression touche tout le monde d'un coup | moyen |
| 9 | **Le compte des « consignes mesurées en échec » n'est dérivé de rien** | `CLAUDE.md` en donne trois valeurs — la forme exacte que le dépôt traque, appliquée à sa propre doctrine | faible |
| 10 | **Node v20.19.4 contre `engines >=22.13.0`** | local seulement ; Vercel respecte `engines` | faible |

### Absences délibérées, et pourquoi elles tiennent

- **Pas de boucle d'auto-correction, pas de modèle-juge, pas de planificateur** — chacun est un
  aller-retour de plus, et l'aller-retour est le poste dominant. Le harness préfère **retirer au
  modèle de quoi mal faire**.
- **Pas de résumé progressif** — un résumé coûte un appel de modèle.
- **Pas de recherche sémantique** — un embedding par message ingéré.
- **Pas de sandboxing** — aucune exécution de code arbitraire, donc aucune surface.
- **Pas de conteneur ni d'orchestrateur** — non pertinent sur Vercel.
- **Pas de protocole inter-agents** — aucun mécanisme de passation n'existe, et la consigne qui
  le prétendait a été supprimée avec deux tests pour protéger la suppression.

---

## La ligne qui traverse cet audit

Les trois quarts de ce harness existent parce qu'une **mesure** a contredit une intuition :

- l'ACK lent ne venait pas du code du handler mais du dépaquetage de la fonction ;
- la limite qui casse la production n'est pas le seau par minute mais le **quota journalier** ;
- le champ `coverage` était ignoré, quel que soit son nom ;
- la base de connaissance était vide alors que tout le code était correct ;
- `readToolCalls` rendait `"unknown"` sur **100 %** des appels ;
- le prompt prescrivait une sortie que le filtre de sortie censurait.

Aucune de ces six ne se voyait à la lecture. Toutes se sont vues à l'exécution.

**Le harness de ce dépôt n'est pas bon parce qu'il est bien conçu. Il est bon parce qu'il est
mesuré — et parce qu'il écrit ce qu'il ne sait pas mesurer.**
