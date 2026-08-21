# Audit Documentation & Features — dépôt `kisso-onboarding`

Date de l'audit : 2026-08-21. Branche : `refactor/cleanup-20260810`, HEAD `5503c65`.
Méthode : extraction mécanique de toutes les références (chemins, symboles, commandes, variables
d'environnement) citées dans la documentation et les commentaires, puis confrontation au code.
Toute affirmation ci-dessous a été vérifiée par une commande, dont le résultat est cité.

**Résumé** : la doctrine du dépôt — *« ne jamais affirmer un état qu'on n'a pas constaté »* — est
appliquée avec une rigueur remarquable à ce qui est **écrit au moment où on l'écrit**, et pas du
tout à ce qui a été écrit **la veille**. Les huit constats HAUTE ci-dessous sont tous du même
genre : une phrase vraie le jour de sa rédaction, jamais recalculée depuis. Deux d'entre eux
portent sur des garde-fous que le dépôt a construits *précisément* pour empêcher ce défaut, et
qui sont aujourd'hui inopérants.

---

## Constats

### [HAUTE] La chaîne LLM documentée n'est plus celle qui tourne — et la clé du modèle primaire est déclarée « config morte à purger »

**Affirmation.**
- `CLAUDE.md:131` (tableau « Stack technique ») : « LLM | Groq `openai/gpt-oss-120b` → fallback
  Mistral `mistral-large-latest` ».
- `CLAUDE.md` (section « Variables d'environnement », bloc final) : « Config morte, encore
  présente dans `.env` / Vercel et **à purger** : `RESEND_API_KEY` …, **`GOOGLE_GEMINI_API_KEY`**,
  `SLACK_USER_TOKEN`, `OPENAI_API_KEY` ».
- Le tableau des variables d'environnement de `CLAUDE.md` ne mentionne `GOOGLE_GEMINI_API_KEY`
  nulle part ; `GROQ_API_KEY` y est décrit comme « LLM primaire ».

**Réalité.** La chaîne réelle compte **trois** maillons et Gemini est le **primaire** :

```
src/shared/llm/model-fallback.ts:23  export const DEFAULT_GEMINI_MODEL_ID = 'gemini-3.5-flash';
src/shared/llm/model-fallback.ts:47    primary: `google/${gemini}`,
src/shared/llm/model-fallback.ts:101   const geminiApiKey = deps.geminiApiKey ?? process.env.GOOGLE_GEMINI_API_KEY;
src/shared/llm/model-fallback.ts:108   if (geminiApiKey) { … }
```

`.env.example:27-31` le déclare d'ailleurs REQUIS (« modèle primaire de TOUS les agents »), et
`.env.example:22` écrit noir sur blanc « La chaîne est Gemini → Groq → Mistral, dans cet ordre,
et l'ORDRE EST LE CONTRAT ». `CLAUDE.md` documente par ailleurs Gemini ailleurs (section « second
rideau » : *« IL PUISE DANS LE MÊME QUOTA QUE MARCEL. Le palier gratuit de Gemini est de 20
requêtes par JOUR »*) — donc **`CLAUDE.md` se contredit elle-même sur sa dépendance la plus
critique**.

C'est le constat le plus dangereux du lot : la ligne « config morte à purger » est une
**instruction d'action**. Un `vercel env rm GOOGLE_GEMINI_API_KEY` exécuté de bonne foi coupe le
modèle primaire de tous les agents. Le repli (Groq) fonctionnerait, donc la panne serait
**silencieuse et lente**, exactement le mode de défaut que ce dépôt traque.

Corollaire : toute la doctrine de coût (« ≈ 19 messages/jour », « le quota JOURNALIER Groq est ce
qui casse la production ») est adossée à un fournisseur qui n'est plus le premier appelé. Elle est
reprise telle quelle dans `.claude/skills/kisso-token-budget/SKILL.md:10-12`.

**Recommandation.** Corriger le tableau « Stack technique », retirer `GOOGLE_GEMINI_API_KEY` de la
liste « à purger » et l'ajouter au tableau des variables comme **requise**. Ajouter
`GEMINI_MODEL_ID`. Réviser `kisso-token-budget` : la contrainte structurante est désormais le
palier Gemini (20 req/jour mesurées), pas le TPD Groq.

---

### [HAUTE] `documentGenerationWorkflow`, `PdfService` et `PdfmakeService.generate()` — trois symboles morts nommés au PRÉSENT

**Affirmation.** `CLAUDE.md`, section `document` :
> « `PdfmakeService implements PdfService, DocumentRenderer` — l'ancienne méthode `generate()`
> écrivant sur disque est **conservée** pour `documentGenerationWorkflow`, seul appelant restant. »

et, dans « Pièges connus » :
> « `documentGenerationWorkflow` **est inchangé** : il utilise toujours `PdfmakeService.generate()`,
> qui écrit dans `./data/documents` et rend un chemin local — inutilisable sur Vercel. »

et encore, dans la section sécurité du rendu :
> « au seuil du RENDU (`buildDocumentOutline`, couche `domain` — seul point qu'aucun renderer ni
> `documentGenerationWorkflow` ne peut contourner) ».

**Réalité.** Les trois symboles n'existent plus.

```
$ find src/features/document -type f
src/features/document/application/tools/generate-document.ts
src/features/document/domain/…            ← aucun répertoire application/workflows/
src/features/document/infrastructure/services/pdfmake.service.ts

$ grep -rn "PdfService" src/          → aucun résultat
$ grep -n "generate(" src/features/document/infrastructure/services/pdfmake.service.ts
                                       → aucune méthode generate()
$ grep -rn "data/documents" src/ scripts/ → aucun résultat
```

`scripts/production-scenarios.mjs:658-661` est, lui, **à jour** : il `skip()` le scénario avec la
raison « retiré du registre le 2026-08-12 ». La documentation de référence, non.

C'est la forme exacte du défaut `discoverSlackWorkspace` que le dépôt a documenté : un commentaire
maintient en vie, par la parole, un composant que plus rien n'appelle. Ici c'est pire, puisque la
phrase sert à **justifier** de conserver du code (« conservée pour … »).

**Recommandation.** Supprimer les trois passages. Vérifier au passage que
`src/features/document/domain/services/printable-text.ts` (existant, non mentionné) figure bien
dans la description des « Trois pièces » de la feature — elles sont quatre.

---

### [HAUTE] La suite de tests n'est PAS verte — échec reproductible

**Affirmation.** `CLAUDE.md:79` : « REVUE GÉNÉRALE DU CONSEIL — 2026-08-19 au soir. Six lots
livrés, **1 801 tests verts**. » `.claude/skills/kisso-verify/SKILL.md` fait de la suite verte le
critère de succès n° 2 avant tout commit.

**Réalité.** `npm run test:unit`, exécuté deux fois (suite complète, puis fichier isolé) :

```
Test Files  1 failed | 314 passed (315)
     Tests  1 failed | 4611 passed (4612)

FAIL tests/unit/knowledge/fact-curtain.test.ts > la lecture des lignes rendues par le modèle
     > lit la forme demandée
Error: Test timed out in 5000ms.
  ❯ tests/unit/knowledge/fact-curtain.test.ts:250:3
```

Reproduit en isolation (`npx vitest run tests/unit/knowledge/fact-curtain.test.ts` →
`1 failed | 18 passed`, `transform 4.65s`) : ce n'est pas une flakiness de machine chargée, c'est
déterministe. Le test est le **premier** de son `describe` et paie le `await import()` dynamique
du `ModelFactSummarizer` à l'intérieur du délai de 5 s ; les 18 suivants, qui réutilisent le
module chargé, passent.

C'est très exactement le mode de panne que `CLAUDE.md` décrit longuement en tête de fichier
(« la suite est restée rouge un run sur trois, toujours par `Timeout 5000ms`, jamais par une
assertion ») et déclare résolu (« trois passes complètes vertes »). Le diagnostic était bon, la
conclusion « c'était la dernière » ne l'était pas — pour la deuxième fois, `CLAUDE.md` ayant déjà
écrit « **Et ce n'était PAS la dernière, contrairement à ce qui était écrit ici.** »

**Recommandation.** Constat de fait : ne plus écrire « N tests verts » sans coller la sortie.
Techniquement, sortir le `await import()` du corps du `it` (le hisser en `beforeAll`) ou poser un
`testTimeout` explicite sur ce fichier.

---

### [HAUTE] `npm run test:unit` exécute un CLONE COMPLET du projet — tous les comptes de tests du dépôt sont invérifiables

**Affirmation.** Les comptes de tests sont utilisés partout comme preuve : `CLAUDE.md:79`
(« 1 801 tests verts »), `TODO.md:256` (« 1 801 »), `README.md:145` (« 1 950 tests »),
`CHANGELOG.md:805` (« 1 924 »), `.claude/skills/kisso-verify/SKILL.md` (« **1 568 tests doivent
passer, 96 fichiers** »).

**Réalité.** Il existe à la racine un répertoire `agent-marcel/` qui est une **copie complète et
figée du projet** — `src/`, `tests/`, `docs/`, `package.json`, `CLAUDE.md`, tout :

```
$ ls agent-marcel/
AGENT.md  CHANGELOG.md  CLAUDE.md  docs  package.json  scripts  src  tests  …

$ git check-ignore -v agent-marcel/
.gitignore:35:/agent-marcel/	agent-marcel/
```

Il est ignoré par git — **mais pas par vitest**. `vitest.config.ts` n'exclut que
`**/node_modules/**`, `**/dist/**`, `**/tests/integration/**`, `**/tests/unit/infrastructure/**`.
Le compte se vérifie exactement :

```
tests/          (hors integration & unit/infrastructure) : 163 fichiers
agent-marcel/tests/  (idem)                              : 152 fichiers
                                                     somme: 315   ← ce que vitest a exécuté
```

Conséquences :
1. **Aucun compte de tests cité dans le dépôt n'est reproductible** — il dépend de la présence
   d'un répertoire local non versionné.
2. La suite tourne en **150 s** au lieu de ~75.
3. Un vert sur `agent-marcel/tests/` ne prouve **rien** sur `src/` : c'est un instantané périmé
   (il ne contient ni `fact-curtain.test.ts`, ni `model-fact-summarizer.service.ts`). Le dépôt
   fait passer 152 fichiers de tests contre du code qui n'est plus le sien.
4. Symétriquement, une régression réelle pourrait être **masquée** par le vert du clone si
   quelqu'un lit le total sans lire les chemins.

**Recommandation.** Ajouter `'**/agent-marcel/**'` à `vitest.config.ts` → `test.exclude` (et à
`vitest.config.integration.ts`), ou supprimer le répertoire. Puis remesurer, une fois, le compte
réel et n'en citer qu'un seul dans un seul endroit.

---

### [HAUTE] La liste « CONTRACTUELLE » du routage Slack omet une bande entière

**Affirmation.** `CLAUDE.md`, section « Intégration Slack » :
> « **Quatre temps, dans cet ordre.** Les listes sont CONTRACTUELLES — les modifier sans mettre
> à jour ce fichier fait mentir la doc »

puis, pour le palier 3 (« THÉMATIQUE, exprimé en CAPACITÉS (`TOPIC_BANDS`) »), quatre bandes
énumérées : `generateDocument`, `sendNotification`, `getChannelHistory`, `findExpertise`.

**Réalité.** `TOPIC_BANDS` en compte **cinq** :

```
src/features/notification/domain/services/agent-routing.ts:102-118
  {
    agentId: 'knowledgeAgent',
    keywords: [],
    requiredTool: 'searchKnowledge',
    pattern: RECALL_QUESTION_PATTERN,     // « qu'est-ce qu'on a dit / décidé / convenu… »
    overridesSticky: true,
  },
```

Cette bande est la **seule porte d'entrée** vers `searchKnowledge`, c'est-à-dire vers toute la
base de connaissance à deux niveaux livrée le 2026-08-21 — la feature la plus récente du produit.
Son commentaire dans le code (`agent-routing.ts:107-117`) documente même une décision fine
(`overridesSticky` passé de `false` à `true` après mesure en production le 2026-08-20). Rien de
tout cela n'a atteint la liste qui se déclare contractuelle.

Écarts mineurs dans la même liste :
- la bande `findExpertise` porte aussi les variantes **non accentuées** `specialiste` et
  `competence` (`agent-routing.ts:97`), absentes de la doc ;
- `EXPERTISE_QUESTION_PATTERN` (`:45-46`) couvre aussi « qui **s'y connaît** », « à qui
  **m'adresser** », « à qui **parler** » ; la doc n'annonce que « à qui je demande ».

**Recommandation.** Ajouter la 5ᵉ bande. Surtout : une liste déclarée « contractuelle » et
recopiée à la main *est* le défaut que ce dépôt combat ailleurs en dérivant ses listes
(`AGENT_TOOLS`, `DETERMINISTIC_REPLIES`, `agentToolBoundary`). Un test qui compare `TOPIC_BANDS`
au tableau markdown de `CLAUDE.md` coûterait vingt lignes et rendrait la promesse tenable.

---

### [HAUTE] `claimed-invariants.test.ts` — le garde-fou anti-« affirmation non recalculée » ne garde RIEN

**Affirmation.** `CLAUDE.md:98-105` :
> « ⚠️ **NOUVEAU GARDE-FOU, et c'est la leçon de méthode du lot** :
> `tests/unit/quality/claimed-invariants.test.ts` vérifie que toute phrase « verrouillé par `X` »
> cite un fichier qui existe. »

**Réalité.** Le test existe et est bien écrit. Mais son motif ne trouve **aucune occurrence** dans
le corpus qu'il scanne :

```
$ grep -rhoE '[Vv]errouill[^ ]*\s+par\s+`[^`]+`' src/
(aucun résultat)
```

Le test itère sur ~195 fichiers, ne matche rien, et passe. Ses deux tests « anti faux-négatif »
ne referment pas le trou : l'un vérifie la regex contre une **chaîne littérale codée en dur**
dans le fichier de test, l'autre compte seulement les fichiers scannés. Aucun ne vérifie que le
motif rencontre quoi que ce soit de réel.

Portée réelle du garde-fou, mesurée :
- **couvre** : uniquement `src/`, uniquement la forme « verrouillé par \`chemin\` », uniquement si
  le chemin contient un `/` **et** se termine par `.ts|.mts|.mjs|.js|.sql` ;
- **ne couvre pas** : `docs/`, `tests/`, `.claude/skills/`, les fichiers `.md` de la racine
  (c'est-à-dire `CLAUDE.md` lui-même) ; les autres formes d'énoncé global que `CLAUDE.md:100-103`
  nomme pourtant explicitement dans la même phrase — « la seule feature qui… », « délibérément
  absente », « aucun appelant », « jamais utilisé », « ce fichier est hermétique » ; les
  **symboles** (fonctions, classes, tables) par opposition aux chemins ; les commandes `npm run` ;
  les variables d'environnement.

Le défaut fondateur qu'il devait empêcher (`tool-classification.test.ts` cité et inexistant) **est
réapparu ailleurs, dans un fichier versionné, deux jours plus tard** — voir le constat suivant.

**Recommandation.** Étendre la source (ajouter `docs/`, `.claude/skills/`, `*.md` de la racine),
et surtout **remplacer le critère par le mien** : extraire *tout* motif ressemblant à un chemin du
dépôt (`(src|tests|scripts|docs)/…\.(ts|mts|js|mjs|sql|md)`) dans tout commentaire et tout
document, et vérifier son existence. Cette seule règle a produit 22 références mortes ci-dessous
en une commande. Prévoir une liste d'exemptions explicite pour les mentions historiques
(« `X` a été retiré »), qui doit rester courte et relue.

---

### [HAUTE] Le test fantôme `code-architecture.test.ts` est TOUJOURS cité — dans un fichier versionné

**Affirmation.** `CLAUDE.md:285-288` présente ce point comme corrigé :
> « **UN** test garde-fou verrouille cette règle : `tests/unit/quality/architecture.test.ts`.
> ⚠️ Cette ligne annonçait **deux** tests, dont `code-architecture.test.ts` — **qui n'a jamais
> existé** (corrigé le 2026-08-19). »

**Réalité.** Le fichier n'existe toujours pas, et il est encore cité — y compris dans le seul
corpus que le projet **versionne** en dehors de `README.md` :

| Fichier:ligne | Citation |
| --- | --- |
| `.claude/skills/kisso-extract-module/SKILL.md:24` | « `tests/unit/quality/architecture.test.ts` **et `code-architecture.test.ts`** » |
| `.claude/skills/kisso-extract-module/SKILL.md:3` (frontmatter `description`) | « the architecture dependency rule that **two guard tests** already lock » |
| `AGENT.md:47` | « **deux** tests garde-fou la verrouillent » |
| `RECAP-PROJET.md:106-107`, `COMMENT-CA-MARCHE.md:955`, `COMPETENCES_ET_ANALYSE.md:800`, `DEAD_CODE_REPORT.md:68`, `REFACTOR_PLAN.md:255` | idem |

Les deux premières lignes sont les plus graves : un skill est chargé **dans le contexte d'un agent
au moment où il travaille**, et sa `description` est ce qui décide de son déclenchement. Un agent
suivant `kisso-extract-module` cherchera un garde-fou qui n'existe pas et conclura qu'il est
protégé.

Vérification de la portée réelle du test qui, lui, existe :
`tests/unit/quality/architecture.test.ts` couvre bien `features/*/domain` (`:55-105`) **et**
`features/*/application` (`:160+`) — l'affirmation de `CLAUDE.md` sur ce point est **exacte**.

**Recommandation.** Corriger les deux lignes de `.claude/skills/kisso-extract-module/SKILL.md`
(prioritaire : c'est versionné et chargé par les agents) et `AGENT.md:47`. Les cinq documents
racine sont traités globalement plus bas.

---

### [HAUTE] La table des abonnements Slack, déclarée « SOURCE UNIQUE DE VÉRITÉ », a au moins cinq copies — et le CHANGELOG la dément

**Affirmation.** `CLAUDE.md:1355` : « ⚠️ **ABONNEMENTS — SOURCE UNIQUE DE VÉRITÉ. Ne PAS recopier
cette liste ailleurs : y renvoyer.** ». `.claude/skills/kisso-slack-contract/SKILL.md:26` :
« **Aucune autre copie de cette liste ne doit exister.** » — et fournit même la commande de
détection.

**Réalité.** En exécutant la commande que le skill fournit lui-même :

```
docs/SLACK_BOT_SETUP.md:52          « message.channels / message.groups — REQUIS depuis le 2026-08-15 »
README.md                            (liste des abonnements)
docs/conception/knowledge.md:49
docs/guides/tests-manuels.md:116
.claude/skills/kisso-slack-contract/SKILL.md:17,58   ← le skill qui interdit la copie en contient une
COMPETENCES_ET_ANALYSE.md:1432
TODO.md:511,517
```

Et surtout, les copies **divergent déjà** :

| Source | État de `message.channels` / `message.groups` |
| --- | --- |
| `CLAUDE.md:1364` (source unique) | **en cours d'ajout** |
| `CLAUDE.md:919` et `CHANGELOG.md:16` (2026-08-21) | « ne sont **toujours pas** abonnés » |
| `CHANGELOG.md:1885` | « ### **Verified** — `message.channels` / `message.groups`, **désormais abonnés** » |
| `docs/SLACK_BOT_SETUP.md:52` | « **REQUIS depuis le 2026-08-15** » |
| `TODO.md:517` | case **non cochée** : « ⚠️ Abonner `message.channels` et `message.groups` » |

L'entrée `CHANGELOG.md:1885` est le cas d'école : intitulée « **Verified** », elle démontre en
réalité que *le code se comporte comme documenté quand on lui fabrique l'événement* — ce qui est
exactement le raisonnement que `.claude/skills/kisso-slack-contract/SKILL.md:9-13` interdit
(« Un test vert ne prouve **rien** sur ce qu'un événement Slack déclenche en production »). Le
skill décrit le piège ; le CHANGELOG y est tombé.

Note factuelle utile : `SUPPORTED_EVENT_TYPES` (`slack-events.handler.ts:292`) vaut
`{'app_mention', 'message', 'team_join'}` — cohérent avec la table, aucun type mort ni jeté.

**Recommandation.** Remplacer les cinq copies par un renvoi. Retitrer ou annoter
`CHANGELOG.md:1885` (le CHANGELOG ne se réécrit pas, mais une note de démenti est dans les usages
du dépôt). Cocher ou requalifier `TODO.md:517`.

---

### [MOYENNE] Le skill `kisso-verify` donne des critères de succès faux — et c'est celui que les agents chargent avant de dire « c'est bon »

**Affirmation.** `.claude/skills/kisso-verify/SKILL.md`, tableau « Ce que chacune attrape » :
- « `test:unit` | La régression de comportement. **1 568 tests doivent passer, 96 fichiers.** »
- « `lint` | … Il reste **~90 warnings connus**, dont le lot ReDoS de `llm-guardrail.ts`. »

**Réalité.**
- Tests : **4 612 sur 315 fichiers** (dont ~2 300 provenant du clone `agent-marcel/`, cf. constat
  plus haut). Le chiffre 1 568 apparaît aussi dans le commentaire de `vitest.config.ts` (« Il n'y
  en avait AUCUNE : 1 568 tests verts ») ; c'est la valeur de `TODO.md:887`, donc antérieure à
  plusieurs lots.
- Warnings : **zéro**, mesuré :

```
$ npx eslint src -f json | …
fichiers lintés: 195 | erreurs: 0 | warnings: 0
```

`CLAUDE.md:1833` le dit d'ailleurs correctement (« ✅ Depuis le 2026-08-18, `npm run lint` rend
ZÉRO warning et zéro erreur — le compte était de 90 la veille »). Le skill a gardé le chiffre de
la veille.

Le risque est concret : le skill exige de « coller la sortie réelle » et interdit d'écrire « tout
est vert » sans compte de tests. Un agent consciencieux comparera `4612` à `1568`, conclura à une
anomalie, et perdra du temps — ou pire, prendra `~90 warnings` pour une tolérance et laissera
passer une régression de lint.

**Recommandation.** Retirer les deux chiffres du skill plutôt que les mettre à jour. Un critère de
succès chiffré dans un document non recalculé se périme en quelques jours ; « 0 erreur de lint »
et « aucun test en échec » sont des critères **stables**, et ce sont les seuls dont le skill a
besoin.

---

### [MOYENNE] `CLAUDE.md` se contredit sur `npm run lint || true`, à deux endroits contre deux

**Affirmation vs Affirmation.**
- `CLAUDE.md:149` (tableau « Commandes ») : « `npm run lint` # eslint src (**suffixé `|| true`** —
  ne casse jamais le build) »
- `CLAUDE.md:1753` (« Pièges connus ») : « `npm run lint` **se termine par `|| true`** : il ne fait
  jamais échouer la CI. »
- `CLAUDE.md:1827` : « **`npm run lint` ne se termine PLUS par `|| true`** (2026-08-14) »
- `CLAUDE.md:1833` : « ✅ Depuis le 2026-08-18, `npm run lint` rend ZÉRO warning et zéro erreur »

**Réalité.** `package.json` : `"lint": "eslint src --ext .ts"`. Aucun `|| true`. Les lignes 149 et
1753 sont fausses ; les lignes 1827 et 1833 sont vraies.

Le tableau « Commandes » est la première chose qu'on lit dans le fichier, la section « Pièges »
la dernière. La correction de 2026-08-14 a été **ajoutée** sans que les deux affirmations
d'origine soient retirées — la mécanique par laquelle ce fichier a atteint 172 Ko.

Note secondaire, vérifiée : `--ext .ts` n'a plus d'effet sous ESLint 10 en flat config, mais il
est toléré — avec ou sans, 195 fichiers sont lintés. La commande fait bien son travail.

**Recommandation.** Corriger `:149` et supprimer `:1753`. Plus généralement : ce fichier accumule
les corrections par empilement plutôt que par remplacement, et c'est la cause structurelle de
plusieurs constats de cet audit. Une passe de dédoublonnage sur les affirmations contradictoires
vaudrait plus que n'importe quelle nouvelle section.

---

### [MOYENNE] Les chiffres de lignes cités pour justifier une décision d'architecture sont faux d'un facteur 1,6

**Affirmation.** `CLAUDE.md:290-292` :
> « le test réel ne couvre que `features/*/domain` et `features/*/application` : **`src/shared/`
> lui est invisible**, alors qu'il pèse **7 715 lignes**, autant que tout le `domain` des 8
> features réunies, et qu'il porte **1 301 lignes de prédicats** n'ayant qu'un seul consommateur
> (`deterministic-replies.ts`). »

**Réalité.**

```
$ find src/shared -name '*.ts' | xargs wc -l | tail -1          →  4 760
$ find src/features/*/domain -name '*.ts' | xargs wc -l | tail -1 →  3 669
$ wc -l src/shared/{greeting,message-shape,distress,profile-done,forget,pin-fact,profile-request}.ts
                                                                 →    833
$ wc -l src/features/notification/domain/services/deterministic-replies.ts
                                                                 →    126
```

Aucun des trois chiffres ne tient : `src/shared/` fait **4 760** lignes et non 7 715 (−38 %) ;
il est **30 % plus gros** que le `domain` des 8 features, pas « autant » ; et les prédicats à
consommateur unique totalisent **833** lignes, pas 1 301.

L'argument de fond — `src/shared/` échappe au garde-fou d'architecture, et c'est une question de
cohésion — **reste vrai** et vérifiable : `grep -rn "from '.*features/" src/shared/` ne rend rien,
donc il n'y a bien aucun cycle. C'est la seule partie de la phrase que quelque chose recalcule.

**Recommandation.** Retirer les chiffres ou les remplacer par la vérification qualitative qui,
elle, est stable et automatisable (« `src/shared/` n'importe aucune feature — vérifié par
grep »). Un chiffre dans un document est une mesure qui ne se remesure pas.

---

### [MOYENNE] La suppression du suivi de tâches est annoncée complète — il en reste le tiers

**Affirmation.** `CLAUDE.md` :
> « ⚠️ **Tout le suivi de TÂCHES a été supprimé le 2026-08-14** : `getTaskList`, l'entité `Task`,
> son port, ses deux dépôts, `task-summary.mapper`, `task.dto`, le catalogue `ONBOARDING_TASKS`,
> **les `onboarding_steps` qui en dérivaient 1:1**, et `scripts/backfill-onboarding.mts`. »

**Réalité.** Ce qui a effectivement disparu : `getTaskList`, `Task`, `task-summary.mapper.ts`,
`task.dto.ts`, `ONBOARDING_TASKS`, `backfill-onboarding.mts` — vérifié, `find src -iname '*task*'`
ne rend rien. `READ_ONLY_TOOL_NAMES` a bien été corrigé
(`claim-reconciliation.ts:127-136` : plus de `getTaskList`, et `findPersonByName` / `findExpertise`
présents comme annoncé).

Mais `onboarding_steps` est intact, et l'étage complet qui l'entoure aussi :

| Ce qui subsiste | Chemin |
| --- | --- |
| Table `onboarding_steps` (4 index, 2 clés étrangères dont `fk_onboarding_steps_task`) | `src/infrastructure/database/schema.ts:367-414` |
| Table `tasks` | `src/infrastructure/database/schema.ts:56` |
| Types `OnboardingStep` / `NewOnboardingStep` | `schema.ts:680,697` |
| Entité `OnboardingStep` | `src/features/onboarding/domain/entities/onboarding-progress.ts:13-36` |
| Port : `findSteps` / `saveStep` / `updateStep` | `src/features/onboarding/domain/ports/onboarding.repository.ts:7-9` |
| Implémentation Drizzle (écrit réellement dans la table) | `src/features/onboarding/infrastructure/repositories/drizzle-onboarding.repository.ts:64-100` |
| Implémentation in-memory | `…/in-memory-onboarding.repository.ts:6,25-35` |

Et aucune de ces trois méthodes n'a d'appelant :

```
$ grep -rn "\.saveStep(\|\.findSteps(\|\.updateStep(" src/ | grep -v repositories/
(aucun résultat)
```

Le seul usage est un test qui **assert leur non-appel** :
`tests/unit/workflows/employee-onboarding.test.ts:140` →
`expect(deps.onboardingRepo.saveStep).not.toHaveBeenCalled()`.

La phrase de `CLAUDE.md` distingue par ailleurs correctement le dépôt de la production (« Les
tables `tasks` et `onboarding_steps` existent toujours en production, non supprimées à dessein »).
Le problème n'est pas la table de production : c'est que le **port, l'entité et deux
implémentations** sont présentés comme supprimés alors qu'ils sont dans `src/` et satisfont une
interface que rien n'exerce.

**Recommandation.** Soit retirer les trois méthodes du port et des deux dépôts (l'entité
`OnboardingStep` et les types de schéma peuvent rester, ils décrivent une table réelle en
production), soit corriger la phrase. Le premier est préférable : la situation actuelle est celle
que `CLAUDE.md` décrit pour `discoverSlackWorkspace` — du code qu'un recâblage pourrait rebrancher
sans le relire.

---

### [MOYENNE] La feature `questionnaire` est annoncée « SUPPRIMÉE du dépôt, pas seulement décâblée » — deux tables et un enum restent

**Affirmation.** `CLAUDE.md` : « ⚠️ **`questionnaire` a été SUPPRIMÉE du dépôt le 2026-08-14** —
pas seulement décâblée. … **Les tables restent en production.** »

**Réalité.** Le répertoire `src/features/questionnaire/` a bien disparu, l'agent
`questionnaireEngine` n'est plus au registre (`src/mastra/index.ts:224-229` : 4 agents), la bande
de routage `questionnaire|évaluation|quiz` a bien été retirée (`agent-routing.ts:3-21`). Sur
l'essentiel, la phrase est vraie.

Restent dans `src/` — pas seulement « en production » :

```
src/shared/types.ts:100                 export enum QuestionnaireStatus { … }   (1 seul lecteur : un test)
src/infrastructure/database/schema.ts:217-258   table `questionnaires` + 5 index
src/infrastructure/database/schema.ts:262-313   table `questionnaire_responses` + index + contrainte d'unicité
src/infrastructure/database/schema.ts:677,678,694,695   4 types inférés
```

`QuestionnaireStatus` n'a qu'un consommateur, `tests/unit/domain/domain-logic.test.ts:12` — un
enum maintenu en vie par son seul test, la définition même du code mort selon ce dépôt.

**Recommandation.** Supprimer `QuestionnaireStatus`. Pour les tables : les garder dans `schema.ts`
est défendable (elles existent en production et `drizzle-kit` s'en sert), mais alors l'écrire —
« le schéma les déclare encore parce que la production les porte » — plutôt que de laisser croire
à une suppression totale.

---

### [MOYENNE] `CONTEXT.md` fait reposer une garantie de VIE PRIVÉE sur un fait devenu faux

**Affirmation.** `CONTEXT.md:19-21` :
> « **KnowledgeAgent** : lecture À LA DEMANDE des conversations du bot et des canaux où il est
> invité, filtrée selon les droits du DEMANDEUR. **Aucune ingestion persistante — ce serait une
> surveillance systématique des communications des salariés.** »

**Réalité.** L'ingestion persistante existe depuis le 2026-08-20/21 :

```
src/features/knowledge/application/services/knowledge-ingestion.service.ts
src/features/knowledge/application/services/fact-curtain.service.ts
src/features/knowledge/infrastructure/repositories/drizzle-message-archive.repository.ts
src/infrastructure/database/schema.ts:707   channel_messages
src/infrastructure/database/schema.ts:733   knowledge_facts
```

Et `CLAUDE.md` documente elle-même la conséquence, en la revendiquant :
> « **Les DM en font partie depuis le 2026-08-21.** ⚠️ Conséquence assumée, décidée par le
> propriétaire : … **le General Manager peut relire les DM de chacun**. Un DM cesse d'être privé. »

`CONTEXT.md` est cité par `CLAUDE.md` comme « contexte complémentaire (métier) ». C'est le seul
document du dépôt qui énonce une **position de principe sur la vie privée**, et il affirme
aujourd'hui l'inverse de ce que le produit fait. Ce n'est pas une doc périmée ordinaire : c'est
une garantie donnée à des salariés.

Deux autres écarts dans le même fichier : `CONTEXT.md:26` décrit l'entretien comme « une modale
Block Kit » (les modales ont été supprimées le 2026-08-19 : `interview-modal.ts` n'existe plus) ;
`CONTEXT.md:41` annonce « 12 outils » et en liste 12, alors qu'il y en a **13** — `searchKnowledge`
manque (`src/shared/agent-capabilities.ts:20`).

**Recommandation.** Réécrire ce paragraphe **en priorité sur tout le reste de l'audit**. Il ne
s'agit pas d'exactitude documentaire mais de la description d'un traitement de données
personnelles.

---

### [MOYENNE] Trois avertissements de `CLAUDE.md` portent sur des fichiers ou commentaires qui n'existent plus

Même famille, trois occurrences. Chacune demande au lecteur de se méfier de quelque chose
d'introuvable — ce qui coûte une recherche à chaque lecture et finit par user la confiance dans
les autres avertissements.

**a) Les deux commentaires « `files:write` est ABSENT ».**
`CLAUDE.md` : « **Toute affirmation contraire est périmée** — elle traîne encore dans deux
commentaires du code (`src/mastra/index.ts` au point de câblage de `fileUpload`, et l'en-tête de
`SlackAdapter.uploadFile`), qui n'ont **PAS** été mis à jour. »
Réalité : `src/mastra/index.ts:124` (`fileUpload: chatProvider,`) ne porte **aucun commentaire** ;
`SlackAdapter.uploadFile` (`slack.adapter.ts:104`) n'a **aucun en-tête**. Les seules mentions de
`files:write` dans `src/` (`generate-document.ts:72`, `slack.adapter.ts:125-126`) décrivent
correctement le chemin `missing_scope`, qui est délibérément conservé. Les deux commentaires
fautifs ont été corrigés ; l'avertissement, non.

**b) `_measure.mts`.**
`CLAUDE.md` : « ⚠️ **`_measure.mts` (racine) est PÉRIMÉ** : son câblage est codé en dur et
n'inclut pas `findEmployeeByEmail` sur `questionnaireEngine` ni sur `notificationAgent`, donc il
sous-estime deux agents sur trois. »
Réalité : `ls _measure.mts` → *No such file or directory*. Le fichier n'existe nulle part dans le
dépôt. L'avertissement décrit au présent un outil disparu, en s'appuyant de surcroît sur un agent
(`questionnaireEngine`) lui-même retiré.

**c) `task-summary.mapper.ts` présenté comme le mécanisme courant.**
`CLAUDE.md:1703-1704` : « `getEmployeeProfile` renvoyait `tasks` non borné … **projeté et borné à
5 tâches / 6 champs via `src/features/employee/application/mappers/task-summary.mapper.ts`** ».
Réalité : le fichier n'existe pas, et `grep -n "tasks" src/features/employee/application/tools/get-employee-profile.ts`
ne rend rien — il n'y a plus de projection parce qu'il n'y a plus de tâches. La même citation
survit dans `docs/conception/notification.md:45`.

**Recommandation.** Supprimer (a) et (b). Pour (c), reformuler au passé sans nommer le fichier :
la leçon (« un tool-result non borné est refacturé à chaque tour ») est ce qui a de la valeur, pas
le chemin.

---

### [MOYENNE] Le contrat des variables d'environnement est incomplet dans les deux sens

**Affirmation.** `CLAUDE.md`, tableau « Variables d'environnement », présenté comme la liste de
référence, complété par la liste « config morte à purger ».

**Réalité.** Recensement exhaustif (`grep -rhoE 'process\.env\.[A-Z_0-9]+' src/ scripts/`) :

*Lues par le code, absentes du tableau de `CLAUDE.md`* (17) :
`GOOGLE_GEMINI_API_KEY` (traitée en HAUTE ci-dessus), `GEMINI_MODEL_ID`, `GROQ_MODEL_ID`,
`MISTRAL_MODEL_ID`, `RECRUITMENT_TIMEZONE`, `DISPLAY_TIMEZONE`, `MASTRA_API_TOKEN`,
`SYSTEM_PROMPT_VAULT_SECRET`, `SLACK_TEAM_ID`, `SLACK_BURST_LIMIT`, `SLACK_DAILY_LIMIT`,
`SLACK_WORKSPACE_TOKEN_BUDGET`, `AUTO_MIGRATE`, `DB_MIGRATIONS_FOLDER`, `SERVICE_NAME`,
`APP_VERSION`, `LIVE_TEST_BASE_URL`.
Plusieurs ne sont pas anodines : `SYSTEM_PROMPT_VAULT_SECRET` et `MASTRA_API_TOKEN` sont des
secrets ; `SLACK_BURST_LIMIT` / `SLACK_DAILY_LIMIT` gouvernent le rationnement décrit sur des
pages entières de `CLAUDE.md` sans que leur variable soit jamais nommée.

*Lue par le code, absente de `CLAUDE.md` **et** de `.env.example`* (1) :
`EMERGENCY_COUNTRY` (`src/shared/emergency-lines.ts:117`). `CLAUDE.md:1181` la mentionne en prose
(« Le Nigeria reste disponible par `EMERGENCY_COUNTRY=NG` ») mais elle ne figure dans aucun des
deux inventaires. C'est la variable qui décide quel numéro d'urgence est donné à quelqu'un en
détresse.

*Déclarée dans `.env.example`, lue uniquement par les tests* (1) :
`INTEGRATION_DATABASE_URL` (`tests/integration/setup.ts:21`) — correct, mais à signaler comme tel.

*« Config morte » — vérification des cinq* :

| Variable | Verdict |
| --- | --- |
| `RESEND_API_KEY` | ✅ morte confirmée (0 occurrence dans `src/`, `scripts/`) |
| `SLACK_USER_TOKEN` | ✅ morte confirmée |
| `OPENAI_API_KEY` | ✅ morte confirmée |
| `SLACK_ORG_EMAIL_DOMAINS` | ✅ morte confirmée — plus aucune autorisation n'en dépend |
| `GOOGLE_GEMINI_API_KEY` | ❌ **VIVANTE ET CRITIQUE** — `model-fallback.ts:101` |

Quatre sur cinq justes ; la cinquième est la clé du modèle primaire.

**Recommandation.** Prendre `.env.example` (14,7 Ko, à jour, versionné) comme source unique et
faire du tableau de `CLAUDE.md` un renvoi. Ajouter `EMERGENCY_COUNTRY` à `.env.example`. Un test
comparant `grep process.env` à `.env.example` fermerait la question définitivement — c'est le même
patron que `claimed-invariants`, appliqué à un corpus où il trouverait quelque chose.

---

### [BASSE] « `grep kisso.internal` → 0 occurrence dans le dépôt » — il y en a 58

**Affirmation.** `CLAUDE.md` : « le faux lien `https://kisso.internal/docs/<uuid>/download` du
2026-08-11 (`grep kisso.internal` → **0 occurrence** dans le dépôt) ».

**Réalité.** `grep -rn "kisso.internal" src/ tests/ scripts/ docs/ *.md | wc -l` → **58**,
réparties sur 10+ fichiers : `tests/unit/security/agent-output.test.ts`,
`tests/unit/tools/generate-document.test.ts`, `docs/conception/{document,shared,notification,onboarding}.md`,
et `CLAUDE.md` elle-même — la phrase se contredit dans son propre fichier.

L'intention est claire et **vraie** : `grep -rc "kisso.internal" src/` ne rend rien, aucun code de
production ne contient cette URL. C'est la formulation « dans le dépôt » qui est fausse.

**Recommandation.** Écrire « 0 occurrence dans `src/` ». Cité ici parce que c'est la forme la plus
pure du défaut recherché : une commande donnée comme preuve, dont le résultat n'a jamais été
rejoué.

---

### [BASSE] Trois scripts `package.json` non documentés — et zéro commande fantôme

**Affirmation / Réalité.** Vérification croisée mécanique dans les deux sens.

*Sens 1 — commandes citées dans les docs mais absentes de `package.json`* : **aucune**. Toutes les
`npm run …` de `CLAUDE.md`, `README.md`, `docs/`, `TODO.md`, `CHANGELOG.md` et `.claude/skills/`
existent. C'est un excellent résultat, à souligner.

*Sens 2 — scripts de `package.json` cités nulle part* : `test:watch`, `prepare`, `format:check`.
Sans gravité (`prepare` est un hook husky), mais `format:check` est le pendant CI de `format` et
mériterait d'être dans le tableau « Commandes ».

**Recommandation.** Ajouter `format:check` au tableau. Le reste est du bruit.

### [BASSE] Le tableau « Stack technique » déclare un paquet qui n'est pas installé

**Affirmation.** `CLAUDE.md:135` : « email : SMTP via `nodemailer` (primaire), Brevo
(**`@getbrevo/brevo`**) en repli ». Repris à l'identique par `README.md:253`.

**Réalité.** `grep -n brevo package.json` → **aucun résultat**. Le repli existe bien, mais
`src/features/notification/infrastructure/providers/brevo.adapter.ts:22` appelle
`https://api.brevo.com/v3/smtp/email` en **`fetch` brut**, sans SDK. Nommer un paquet non installé
dans le tableau de référence de la pile technique induit en erreur quiconque cherche à comprendre
ce que le repli emporte comme dépendance — ou tente de l'auditer.

**Recommandation.** Écrire « Brevo (API HTTP, sans SDK) ». Corollaire utile pour l'audit de
dépendances : le repli email n'ajoute **aucune** dépendance, ce qui est un point fort à conserver.

---

## Constats sur `docs/` (corpus versionné)

### [HAUTE] `docs/api.md` se présente comme le miroir de `server.apiRoutes` et omet une route sur cinq — la seule déclenchée par un cron

**Affirmation.** `docs/api.md:3` présente le document comme le reflet de `server.apiRoutes`.
`docs/api.md:8` : « Ce serveur expose **deux familles de routes**, avec **deux authentifications
différentes** ». Le tableau « Récapitulatif » (`docs/api.md:217-225`) compte cinq lignes.

**Réalité.** `src/mastra/index.ts:239-247` monte **cinq** routes, dont
`remindersDispatchRoute`. `GET /internal/reminders/dispatch` (`src/api/reminders-dispatch.route.ts:54`)
est absent de `docs/api.md` — vérifié : `grep -n "reminders\|CRON_SECRET" docs/api.md` ne rend
rien. C'est pourtant :
- la **troisième** famille d'authentification (`Authorization: Bearer $CRON_SECRET`,
  `reminders-dispatch.route.ts:41-52`), pas la deuxième ;
- la **seule** route en `GET` (les quatre autres sont `POST`) ;
- la **seule** déclenchée par une horloge (`vercel.json` → `crons`) ;
- **fail-closed** : sans `CRON_SECRET`, elle rend `503` et aucun rappel ne part —
  `CLAUDE.md` insiste longuement sur ce point, `docs/api.md` l'ignore.

**Recommandation.** Ajouter la section 6 et la ligne de récapitulatif. C'est le document qu'on
consulte pour savoir « qu'est-ce qui est exposé » ; une route d'envoi de messages à des salariés
n'a pas à y manquer.

---

### [HAUTE] `docs/SLACK_BOT_SETUP.md` — un lecteur qui suit ce guide ne démarre pas le modèle primaire, et route vers un agent supprimé

**Affirmation.** `docs/SLACK_BOT_SETUP.md:172-173`, section « Variables d'Environnement
Requises » :
```
GROQ_API_KEY=…      # primaire — llama-3.3-70b-versatile
MISTRAL_API_KEY=…   # fallback — mistral-large-latest
```
`docs/SLACK_BOT_SETUP.md:132-135` documente un « **Questionnaire Engine** » avec les mots-clés
`questionnaire`, `évaluation`, `quiz`, `test`. `:149` et `:151-152` donnent des exemples
d'utilisation (« Créer un employé nommé Jean Dupont… », « Génère un questionnaire… »).

**Réalité.**
- Le primaire est `google/gemini-3.5-flash` (`model-fallback.ts:23,47`), et `GOOGLE_GEMINI_API_KEY`
  est **totalement absente** de la section des variables requises.
- `llama-3.3-70b-versatile` a été retiré du compte Groq le 2026-08-15 ; le modèle Groq est
  `openai/gpt-oss-120b` (`model-fallback.ts:25`).
- `MASTRA_API_TOKEN` et `CRON_SECRET` manquent aussi de cette section.
- `questionnaireEngine` n'existe plus ; **aucun** des quatre mots-clés ne figure dans
  `agent-routing.ts:3-36`. Le guide omet en revanche `recruitmentAgent` et `knowledgeAgent`.
- Aucun tool `createEmployee` n'est câblé (`src/mastra/index.ts:145-152`) : l'exemple `:149`
  documente un chemin délibérément fermé.

Deux autres affirmations de ce guide sont démenties par le code :
- `:226` « **`inngest` est déjà une dépendance du projet** » → `grep -rn inngest package.json src/`
  → **0 occurrence**.
- `:250-253` « La déduplication se fait … via un cache LRU **en mémoire, donc par instance** :
  avec plusieurs instances serverless concurrentes, la dédup ne tient pas. » → la déduplication
  partagée existe (`schema.ts:565` table `slack_event_dedup`,
  `drizzle-slack-event-dedup.repository.ts`, DDL appliqué), ce que `docs/api.md:65` dit
  correctement. **Les deux documents versionnés se contredisent.**

**Recommandation.** C'est le document d'installation : il doit être corrigé en premier après
`CONTEXT.md`. Un nouvel arrivant qui le suit obtient un bot qui tombe directement sur son repli.

---

### [MOYENNE] Les guides de test décrivent des campagnes inexécutables

**Affirmation / Réalité**, vérifiées ligne à ligne :

| Fichier:ligne | Affirmation | Réalité |
| --- | --- | --- |
| `docs/guides/tests-manuels.md:134-144` | « Mots-clés **contractuels** : `questionnaire\|évaluation\|quiz\|test` → `questionnaireEngine` » ; « ⚠️ Le mot « test » route vers `questionnaireEngine` » | Aucun de ces mots dans `agent-routing.ts`. Le test T4 (`:111`) envoie « teste le routage » en s'appuyant sur cette règle |
| `docs/guides/tests-manuels.md:150-184` | Test T6 « Création d'un employé par l'agent », log attendu `tool call validation failed … createEmployee` | Aucun tool `createEmployee` câblé. `scripts/production-scenarios.mjs:750` le dit : « `createEmployee` est **DÉCÂBLÉ** » |
| `docs/guides/tests-manuels.md:228-233` | Test T8 : `POST /api/workflows/documentGenerationWorkflow/start-async` | Workflow inexistant → 404 |
| `docs/guides/tests-manuels.md:290-294` | « Correctif prévu : `sanitizeRichText`, **déjà présent dans `src/shared/validation.ts`** » | `grep -rn sanitizeRichText src/` → **0 occurrence** |
| `docs/guides/tests-manuels.md:5` | renvoi vers `docs/guides/tests-production.md` | Fichier inexistant |
| `docs/guides/tests-agents-2026-08-12.md:196` | « il n'existe **ni cron ni poller**, et **`findPending()` n'a aucun appelant** » | `vercel.json` → cron ; `src/mastra/index.ts:244` monte la route ; `dispatch-due-reminders.ts:59` appelle `findPending()`. `src/mastra/index.ts:242-243` dit explicitement l'inverse du guide |
| `docs/guides/tests-agents-2026-08-12.md:74,126-179,235` | Inventaires d'outils par agent | `getTaskList` cité (inexistant) ; `findPersonByName`/`findExpertise`/`searchKnowledge` omis ; section `questionnaireEngine` entière (Q1–Q5) inexécutable ; `recruitmentAgent` jamais mentionné alors que le titre annonce « les 4 agents » |
| `docs/guides/onboarding.md:13,20,21,31-38` | « 3 agents (Orchestrateur, Questionnaire, Notification) » ; « crée l'adresse e-mail » ; « l'ajoute à l'organisation GitHub » ; « génère la to-do list » | 4 agents ; aucun provisioning email ni GitHub dans `src/` ; aucun mécanisme de tâches |
| `docs/guides/onboarding-agent-update.md:7,11,13,20,25,34` | `QuestionnaireEngine`, tool `createEmployee`, `getTaskList`, `@mastra/core v1.53.0`, `src/agents/onboarding-orchestrator.ts`, « nous entamons actuellement… » | Tous faux ; `package.json` épingle `^1.57.0` ; document daté du 29 juillet présentant comme à faire ce qui est livré |

**Recommandation.** `onboarding-agent-update.md` et `tests-agents-2026-08-12.md` sont datés dans
leur nom ou leur contenu : les déplacer sous `docs/archive/` avec une bannière. `tests-manuels.md`
et `onboarding.md` ne portent pas de date et se lisent comme actuels : ce sont eux qu'il faut
réécrire ou supprimer.

---

### [MOYENNE] `docs/conception/` — quatre renvois morts et la chaîne LLM d'avant-hier

`docs/conception/` (10 fichiers, produits par l'extraction des commentaires du 2026-08-20) est le
corpus le plus sain du dépôt : **tous** les en-têtes `## \`chemin.ts\`` pointent vers un fichier
existant. Les écarts sont ponctuels mais réels.

**a) Renvois morts** — quatre, tous présentés comme consultables :

| Fichier:ligne | Renvoi | État |
| --- | --- | --- |
| `docs/conception/notification.md:45` | « Le remède est le même que dans `src/features/employee/application/mappers/task-summary.mapper.ts` : » | fichier supprimé |
| `docs/conception/document.md:1104` | « (2 506 → 329 tokens, **voir `task-summary.mapper.ts`**) » | idem |
| `docs/conception/onboarding.md:250` | « Le rattrapage **a déjà un propriétaire** : `scripts/backfill-onboarding.mts` » | script supprimé — et c'est ce mécanisme inexistant qui **justifie** de ne rien écrire dans `updateOnboardingStatus` |
| `docs/conception/document.md:1954` | « aucun questionnaire n'est envoyable ni remplissable, **cf. `generate-questionnaire.ts`** » | fichier supprimé |

**b) Chaîne LLM.** `docs/conception/shared.md:1457,1490,1492,1499` décrit
`PRIMARY_MODEL_ID = \`groq/${GROQ_MODEL_ID}\`` et `FALLBACK_MODEL_ID = \`mistral/…\`` — une chaîne
à **deux** maillons sans Gemini. Réalité : trois maillons, `primary: google/…`
(`model-fallback.ts:47-49`). Même erreur que `CLAUDE.md:131` et `README.md`.

**c) « trois agents » vs « quatre », dans le même fichier.**
`docs/conception/shared.md:100,104,3093,3118` et `knowledge.md:120,1261` disent « les **trois**
agents » ; `shared.md:285,440,3002,3074` disent « les **quatre** ». Il y en a quatre.

**d) Deux inventaires faux.** `docs/conception/document.md:824` énumère « les trois lectures RH
(`getEmployeeProfile`, **`getTaskList`**, `getNotificationHistory`) » ;
`docs/conception/plateforme.md:1899-1905` documente la colonne `agent_id` comme
`onboardingOrchestrator | questionnaireEngine | notificationAgent`.

**e) Une affirmation retournée.** `docs/conception/plateforme.md:3524` : « `questionnaireEngine` …
**Les deux restent dans le dépôt, testés ; seule leur EXPOSITION disparaît.** » — ils ont été
supprimés du dépôt. Et `plateforme.md:443-447` annonce qu'il reste à retirer `profile-modal.ts`,
`interview-modal.ts` et `applyInterview`, alors que `plateforme.md:492` du même fichier dit
`profile-modal.ts` « supprimé le même jour ».

**f) `evaluateResponse` au présent.** `docs/conception/employee.md:456` l'énumère parmi des outils
existants ; il n'existe plus.

**Recommandation.** Ces six points sont des corrections ponctuelles sur un corpus par ailleurs
solide — c'est le meilleur rapport effort/effet de tout l'audit.

---

### [MOYENNE] `docs/adr/` — deux séries d'ADR se disputent les numéros 001 à 005

**Affirmation.** La règle du projet (`CLAUDE.md`, « Règles de travail » n° 4) : « Ne pas modifier
un ADR existant — en créer un nouveau. »

**Réalité.** `docs/adr/` contient **deux séries indépendantes** portant les mêmes numéros :

| N° | Série `00N-titre.md` | Série `ADR-00N.md` |
| --- | --- | --- |
| 001 | Architecture et Stack Technique | Record Architecture Decisions |
| 002 | Structure Agents Mastra | Clean Architecture et Structure du Projet |
| 003 | Modèle de Données | Agents, Outils et Workflows Mastra |
| 004 | Stratégie de Notifications | Schéma de Base de Données |
| 005 | Workflows et Orchestration | Notifications Multi-Canal |

Ce ne sont pas des doublons : **dix décisions distinctes sur cinq numéros**. Conséquence directe,
vérifiée : `docs/adr/006-fournisseur-email-smtp.md:7` écrit « L'ADR-004 prévoyait un
`EmailAdapter` » — vrai de `004-strategie-de-notifications.md:15`, faux de `ADR-004.md` (schéma de
base de données). **Toute référence « ADR-00N » dans ce dépôt est ambiguë.**

Les deux séries divergent aussi sur le vocabulaire de statut (`ADR-001.md:12` impose « Adopté » ;
la série A utilise « Accepté » partout) et sur le modèle de données
(`003-modele-de-donnees.md:10-44` : 4 tables ; `ADR-004.md:11-19` : 8 tables ;
`schema.ts` : **21**).

**Aucun ADR ne porte le statut `Déprécié` ou `Remplacé`**, alors que six décisions ont été annulées
sans ADR de remplacement : suppression de `questionnaireEngine`, suppression du suivi de tâches,
passage à Gemini primaire, suppression des modales et boutons, ajout du cron de rappels, ajout de
`knowledgeAgent` et `recruitmentAgent`. Seul `006-fournisseur-email-smtp.md` respecte la forme
(nouveau fichier), sans pour autant marquer `004-…md` comme partiellement remplacé.

Contenu périmé le plus visible : `002-…md:10` « 3 agents dans `src/agents/` » et `ADR-002.md:12-25`
(arborescence `src/domain/`, `src/agents/`, `src/tools/`, `src/workflows/`, `src/prompts/`,
`src/config/`, `application/use-cases/`) — **aucun de ces sept répertoires n'existe**. C'est
précisément la carte dont `AGENT.md:3-7` dit qu'un agent qui la lirait « aurait cherché des
répertoires absents ».

**Recommandation.** (1) Renommer une série pour lever la collision — la série `ADR-00N.md` est la
plus périmée et la moins citée. (2) Poser un statut `Remplacé par …` en tête des ADR annulés,
ce qui est conforme à la règle (on n'en change pas le contenu). (3) Écrire les ADR manquants,
en priorité celui du passage à Gemini primaire : c'est une décision d'architecture non tracée.

---

### [BASSE] `docs/plans/2026-08-19-conseil-revue-generale.md` — un plan livré dont les constats « VÉRIFIÉ » ont été corrigés depuis

**Affirmation.** `docs/plans/2026-08-19-conseil-revue-generale.md:7-9` : « Chaque constat porte une
référence `fichier:ligne` et une mention **VÉRIFIÉ** ». `CLAUDE.md:105` renvoie vers ce document
pour « le détail et ce qui reste ».

**Réalité.** Le plan a été **exécuté**, mais rien ne le dit : il se lit encore comme un état des
lieux. Ses deux constats les plus cités sont désormais faux **parce qu'ils ont été corrigés** :

- `:85-86` « `READ_ONLY_TOOL_NAMES` contient encore `getTaskList` … et ignore `findPersonByName` et
  `findExpertise` » → `claim-reconciliation.ts:127-136` contient exactement les 8 bons noms, sans
  `getTaskList`.
- `:91-92` « `tests/unit/quality/tool-classification.test.ts` — qui **n'existe pas** » → le fichier
  existe (`tests/unit/quality/` en contient six).

S'y ajoute un effet mécanique : l'extraction des commentaires vers `docs/conception/` (2026-08-20)
a raccourci `src/` de plusieurs milliers de lignes **après** la rédaction du plan. La quasi-totalité
de ses références `fichier:ligne` pointent désormais hors fichier — par exemple huit renvois à
`slack-events.handler.ts` entre les lignes 2467 et 3231 pour un fichier qui en compte **2 626** ;
`welcome-email.ts:108` pour 76 lignes ; `forget.ts:287` pour 122.

**Recommandation.** Ajouter une bannière « plan LIVRÉ le … — les constats ci-dessous décrivent
l'état d'AVANT » et déplacer sous `docs/plans/archive/`. C'est la convention que `CHANGELOG.md`
applique déjà et qui rend ses entrées anciennes lisibles sans piéger personne.

---

### [BASSE] Une affirmation du sous-audit que j'ai vérifiée et REJETÉE — les boutons d'entretien

Je consigne ce point parce qu'il illustre la limite de l'exercice.

Un examen de `docs/api.md:99-101` (« Il ne reste aucun bouton sur le chemin nominal … **aucun code
n'en émet plus** ») pouvait laisser croire à une affirmation fausse :
`src/features/recruitment/infrastructure/handlers/interview-confirm.ts:75-98` construit bel et bien
deux boutons (`SEND_INTERVIEW_ACTION_ID`, `CANCEL_INTERVIEW_ACTION_ID`), et le fichier est câblé
au chemin nominal (`src/mastra/index.ts:34,201`).

**Vérification.** Le presenter réellement câblé n'émet **que du texte** :

```
interview-confirm.ts:132-135
  export const slackInterviewConfirmationPresenter: InterviewConfirmationPresenter = {
    buildConfirmationText: (input) => buildInterviewConfirmText(input),   // « Réponds « oui » ou « non ». »
    fallbackText: …
  };

$ grep -rn "buildInterviewConfirmBlocks" src/ tests/ scripts/
src/features/recruitment/infrastructure/handlers/interview-confirm.ts:51:  export function buildInterviewConfirmBlocks(  ← définition
tests/unit/quality/architecture.test.ts:164                                ← mention dans un commentaire
```

**Zéro appelant.** `CLAUDE.md` et `docs/api.md` ont donc **raison**.

Ce qui reste à signaler : `buildInterviewConfirmBlocks` est du code mort exporté, et la véracité de
la phrase « aucun code n'en émet plus » dépend entièrement du fait qu'il le reste. C'est exactement
la situation de `discoverSlackWorkspace` avant sa suppression, telle que `CLAUDE.md` la décrit :
*« du code qu'un futur recâblage aurait pu rebrancher sans le relire »*. La bonne action n'est pas
de corriger la doc, c'est de supprimer la fonction — et alors la phrase devient vraie *par
construction* plutôt que par surveillance.

**Recommandation.** Supprimer `buildInterviewConfirmBlocks`. Note de méthode : sur ce dépôt, un
symbole exporté n'est pas une preuve d'usage — la vérification doit toujours descendre jusqu'au
site d'appel.

---

## Documents de travail à la racine — verdict de péremption

Les quatorze fichiers `*.md` de la racine (hors `CLAUDE.md`, `TODO.md`, `CHANGELOG.md`) datent tous
du **14 août** sauf `README.md` (20 août). Le code a considérablement bougé depuis.

⚠️ **Ils ne sont pas versionnés** : `.gitignore` contient `/*.md` puis `!README.md`. Ils n'existent
que sur ce poste, ne sont pas relus en revue, et ne survivront pas à un clone. Cela change la
recommandation : il ne s'agit pas de « corriger de la documentation », mais de décider ce qui
mérite d'entrer dans `docs/` et ce qui doit disparaître.

| Document | Verdict | Écart le plus parlant | Action |
| --- | --- | --- | --- |
| `README.md` **(versionné)** | Partiellement périmé | `:46-47,84,248` chaîne « Groq → Mistral » ; `GOOGLE_GEMINI_API_KEY` absente ; `:253` « `@getbrevo/brevo` » n'est pas dans `package.json` ; `:197-210` « Deux fonctions, pas une » ignore la route cron ; `:145` « ~1 950 tests » | **Réécrire** §env / §pile / §déploiement |
| `AGENT.md` | Partiellement périmé | `:28` « Groq `llama-3.3-70b-versatile` » ; `:41-42` 7 features, `recruitment` omise ; `:47` « **deux** tests garde-fou » ; `:59` gatekeeper sans `lint` | **Réécrire** (5 lignes ; cité par `CLAUDE.md`) |
| `CONTEXT.md` | Partiellement périmé | `:19-21` « **Aucune ingestion persistante** » (voir constat MOYENNE dédié) ; `:26` « modale Block Kit » ; `:41` « 12 outils » → 13 | **Réécrire en priorité** |
| `GEMINI.md` | Périmé | `:14` « Agents dans `src/agents/`, Tools dans `src/tools/`, Workflows dans `src/workflows/` » — **aucun n'existe** ; `:10` « fichiers < 300 lignes » alors que 13 fichiers dépassent | **Supprimer** |
| `ANTIGRAVITY.md` | Périmé | `:4` oriente vers `GEMINI.md`, le document le plus faux du dépôt, et ne cite pas `CLAUDE.md` | **Supprimer** |
| `conversation_summary.md` | Périmé | `:27` « Dockerfile multi-stage » (aucun `Dockerfile`) ; `:30` « déploiement PaaS (Railway, Render) » ; `:36` renvoie à `test_plan.md`, absent | **Supprimer** |
| `RECAP-PROJET.md` | Périmé | `:135-138` « Tools (12) » dont cinq inexistants ; `:144-146` « Workflows (4) » → 1 ; `:129` `questionnaireEngine` ; `:97-98` `src/config/` | **Archiver** |
| `COMMENT-CA-MARCHE.md` | Périmé | `:4` « il en reste **3 et 1** » (agents/workflows) → 4 et 1 ; `:14` « 10 639 lignes de `src/` » → 22 704 ; `:1077` « supprimer `@ai-sdk/google` : zéro import » → **réinstallé et primaire** | **Archiver** |
| `COMPETENCES_ET_ANALYSE.md` | Périmé | `:1131` « Variables mortes en prod : … **`GOOGLE_GEMINI_API_KEY`** … `vercel env rm` » — **inversion complète**, appliquer couperait le bot ; ~15 scénarios de test sur un routage `questionnaire` supprimé | **Archiver** |
| `TEST_REPORT.md` | Périmé | `:188,374` « 10 tables applicatives et 69 index » → **21 tables** dans `schema.ts` ; `:378` renvoie à `scripts/production-test.ts`, supprimé | **Supprimer** |
| `DEAD_CODE_REPORT.md` | Partiellement périmé | Colonne A (code depuis supprimé) : constats exacts, action close. **Colonne B, dettes encore ouvertes** : alias `tsconfig.json:17,19` `@domain/*`/`@config/*` pointent toujours vers du vide ; `tests/security/llm-gateway/llm-guardrail.test.ts:14` définit toujours `const validateLLMOutput = (output) => output` — un test de théâtre | **Archiver APRÈS extraction des dettes B vers `TODO.md`** |
| `DEPENDENCIES_REPORT.md` | Partiellement périmé | `:46` « `@ai-sdk/google` \| 0 occurrence \| ✅ désinstallé » → réinstallé (`^4.0.48`) et **primaire** ; `:177-180` la vulnérabilité `undici` qu'il annonçait résolue est réintroduite par la même dépendance | **Archiver** (noter le retour de `@ai-sdk/google`) |
| `REFACTOR_PLAN.md` | Périmé | `:12` « **EN ATTENTE DE VALIDATION**. Aucune modification n'a été effectuée » → exécuté ; `:243` `src/shared/retry.ts` (584 lignes) n'existe pas ; s'articule sur `REFACTOR_LOOP.md`, absent | **Supprimer** |
| `PLAN-ARCHITECTURE.md` | Partiellement périmé | `:4-5` « cité par le code : **20 renvois dans `src/`** » → **2**, dans `outbound-tool-quarantine.ts:34` et `read-tool-quarantine.ts:17` ; `:373,387,392` réutilisent les tables `questionnaires` | **Garder, corriger `:4-5`, DÉPLACER sous `docs/`** |

⚠️ **`PLAN-ARCHITECTURE.md` est le cas à traiter en premier** : deux fichiers de `src/` en
production citent ses paragraphes §3.1 et §4.2 comme leur justification, et `.gitignore` l'exclut
du dépôt. Le code versionné renvoie donc à un document que personne d'autre n'a.

**Trois erreurs traversent presque tous ces documents**, `CLAUDE.md` comprise, et devraient être
corrigées d'un seul geste : (a) la chaîne LLM ; (b) le `|| true` du lint ; (c) le second test
garde-fou d'architecture.

---

## Références mortes

Tout fichier, symbole, test ou commande cité quelque part et **inexistant**. Colonne « Cadre » :
*historique* = la citation dit explicitement que la chose a été retirée (légitime) ;
*présent* = la citation la décrit comme existante (**à corriger**).

### Fichiers

| Référence morte | Cité dans | Cadre |
| --- | --- | --- |
| `tests/unit/quality/code-architecture.test.ts` | `.claude/skills/kisso-extract-module/SKILL.md:3,24` · `AGENT.md:47` · `RECAP-PROJET.md:106` · `COMMENT-CA-MARCHE.md:955` · `COMPETENCES_ET_ANALYSE.md:800` · `DEAD_CODE_REPORT.md:68` · `REFACTOR_PLAN.md:255` | **présent** (n'a jamais existé) |
| `src/features/employee/application/mappers/task-summary.mapper.ts` | `CLAUDE.md:1704` · `docs/conception/notification.md:45` · `docs/conception/document.md:1104` | **présent** |
| `scripts/backfill-onboarding.mts` | `docs/conception/onboarding.md:250` | **présent** |
| `docs/guides/tests-production.md` | `docs/guides/tests-manuels.md:5` | **présent** |
| `scripts/apply-ddl.mjs` (le vrai est `.mts`) | `docs/superpowers/plans/2026-08-13-…md:1227` | **présent** |
| `src/agents/onboarding-orchestrator.ts` | `docs/guides/onboarding-agent-update.md:25` | **présent** |
| `src/features/notification/infrastructure/handlers/profile-modal.ts` | `docs/superpowers/plans/2026-08-13-…md:716,730,849,1245,1261,1309` · `docs/conception/plateforme.md:443` | **présent** |
| `tests/unit/handlers/profile-modal.test.ts` | `docs/superpowers/plans/2026-08-13-…md:1248,1304` | **présent** |
| `src/features/questionnaire/application/tools/generate-questionnaire.ts` | `docs/conception/document.md:1954` | **présent** |
| `src/shared/retry.ts` | `REFACTOR_PLAN.md:243` · `tests/unit/security/generate-timeout.test.ts:6` | présent / historique |
| `_measure.mts` | `CLAUDE.md` (section FLOOR) | **présent** |
| `REFACTOR_LOOP.md` | `REFACTOR_PLAN.md:12` | **présent** |
| `test_plan.md` | `conversation_summary.md:36` | **présent** |
| `Dockerfile` | `conversation_summary.md:27` | **présent** |
| `src/config/index.ts` | `RECAP-PROJET.md:67,375,459` · `REFACTOR_PLAN.md:194,221` · `COMPETENCES_ET_ANALYSE.md:1138` | **présent** |
| `src/features/employee/application/tools/create-employee.ts` | `REFACTOR_PLAN.md:241` | **présent** |
| `src/features/employee/application/dtos/task.dto.ts` | `REFACTOR_PLAN.md:245` | **présent** |
| `scripts/production-test.ts` · `scripts/production-test-mocked.ts` | `TEST_REPORT.md:378` | présent |
| `tests/unit/workflows/workflows-e2e.test.ts` · `tests/unit/setup.test.ts` · `tests/unit/security/llm-guardrail.extended.test.ts` · `tests/unit/infrastructure/{infra-db,pdfmake.service,slack-workspace.service}.test.ts` | `DEAD_CODE_REPORT.md:67-71` · `TEST_REPORT.md:54` | historique (rapport de code mort) |
| `src/mastra/core.ts` | `DEAD_CODE_REPORT.md:208` | historique (l'argument repose sur son absence) |
| `src/features/onboarding/domain/services/{profile,interview}-chat.js` | commentaires de `src/` | **présent** (extension `.js` au lieu de `.ts`) |
| `src/agents/`, `src/tools/`, `src/workflows/`, `src/prompts/`, `src/domain/`, `src/config/`, `application/use-cases/` (répertoires) | `docs/adr/ADR-002.md:12-25` · `docs/adr/002-…md:10` · `docs/adr/005-…md:10` · `GEMINI.md:14` | **présent** |

### Symboles

| Symbole mort | Cité dans | Cadre |
| --- | --- | --- |
| `documentGenerationWorkflow` | `CLAUDE.md` (×3, dont « est inchangé ») · `docs/adr/005-…md:27` · `docs/guides/tests-manuels.md:228` · `docs/superpowers/specs/2026-08-11-…md:66` | **présent** |
| `PdfService` · `PdfmakeService.generate()` | `CLAUDE.md` (section `document`) | **présent** |
| `getTaskList` | `docs/adr/002-…md:14` · `docs/conception/document.md:824` · `docs/guides/tests-agents-2026-08-12.md:74` · `docs/guides/onboarding-agent-update.md:13,21` · `RECAP-PROJET.md:135` · `COMMENT-CA-MARCHE.md:313,467` | **présent** |
| `questionnaireEngine` · `generateQuestionnaire` · `evaluateResponse` | `docs/adr/002-…md:17-20` · `ADR-003.md:15,19` · `docs/SLACK_BOT_SETUP.md:132-135` · `docs/conception/employee.md:456` · `docs/conception/plateforme.md:1905,3524` · `docs/guides/*` · `CONTEXT.md:7,70` | **présent** |
| tool `createEmployee` | `docs/adr/002-…md:14` · `docs/SLACK_BOT_SETUP.md:149` · `docs/guides/tests-manuels.md:150-184` · `docs/conception/directory.md:1084` | **présent** |
| `sanitizeRichText` | `docs/guides/tests-manuels.md:294` (« déjà présent dans `src/shared/validation.ts` ») | **présent** |
| `InAppAdapter` · `NotificationService` | `docs/adr/004-…md:17` · `docs/adr/ADR-005.md:16` | **présent** |
| `NotificationChannel` décrit comme une **interface** | `docs/adr/ADR-005.md:12` | **présent** (c'est un enum, `src/shared/types.ts:152`) |
| `NotificationCycle` · `QuestionnaireCycle` (workflows) | `docs/adr/002-…md:25` · `004-…md:10` · `005-…md:17,22` | **présent** |
| `readToolCalls` · `selectExcerpts` | `CLAUDE.md` | historique (récits de correction) |
| `ProfileModalPrefill` · `applyInterview` · `discoverSlackWorkspace` · `buildProfileButtonBlock` · `buildInterviewInviteBlocks` | `CLAUDE.md` · `docs/conception/*` · `docs/plans/2026-08-19-…md:310` | historique |
| `ONBOARDING_TASKS` · `Task` · `task.dto` | `CLAUDE.md` (« supprimés ») | historique |

### Commandes et dépendances

| Référence morte | Cité dans | Cadre |
| --- | --- | --- |
| `npm run …` | **aucune** — les 22 commandes citées dans les docs existent toutes dans `package.json` | ✅ |
| dépendance `inngest` | `docs/SLACK_BOT_SETUP.md:226` (« est **déjà** une dépendance du projet ») | **présent** — 0 occurrence |
| paquet `@getbrevo/brevo` | `README.md:253` · `CLAUDE.md:139` (tableau Stack) | **présent** — absent de `package.json` ; `brevo.adapter.ts` appelle l'API en `fetch` brut |
| `@ai-sdk/openai` | `docs/adr/001-…md:20` | **présent** |
| `GOOGLE_GEMINI_API_KEY` classée « config morte à purger » | `CLAUDE.md` · `COMPETENCES_ET_ANALYSE.md:1131` · `DEAD_CODE_REPORT.md:191` | **inversion** — clé du modèle primaire |

---

## Points forts

Il faut le dire nettement : **cette documentation est parmi les meilleures que j'aie auditées**, et
plusieurs de ses pratiques mériteraient d'être copiées ailleurs.

1. **Elle documente les CAUSES, pas les comportements.** Presque chaque section de `CLAUDE.md`
   répond à « pourquoi ce code a cette forme » plutôt qu'à « ce que ce code fait ». L'explication
   du palier collant, celle de `overridesSticky`, celle du choix `Uint8Array` plutôt que `Buffer` :
   ce sont des arbitrages qu'aucune lecture du code ne restituerait, et qui seraient re-tranchés à
   l'envers sans elles.

2. **Elle nomme les erreurs commises, avec leur symptôme et leur coût.** « Ce piège a rendu
   `createCallerErrorMiddleware` inopérant depuis son écriture — son chemin `throw` fonctionnait,
   d'où l'illusion ». « Les deux réponses les plus fausses de la campagne venaient de là ». « La
   feature marchait pour son testeur ». Ce registre — l'aveu daté et chiffré — est ce qui rend la
   suite crédible, et c'est extrêmement rare.

3. **Les listes CRITIQUES sont dérivées, pas recopiées.** `AGENT_TOOLS` gouverne le routage ;
   `agentToolBoundary` est construit sur `Object.keys(tools)` ; `DETERMINISTIC_REPLIES` est la table
   dont `isAnsweredWithoutModel` est le miroir. C'est la bonne réponse au problème, et elle
   fonctionne : **le câblage agent↔outils, les 9 court-circuits, les 13 outils, les 4 agents, le
   workflow unique, les constantes numériques et `SUPPORTED_EVENT_TYPES` sont TOUS exacts** —
   c'est-à-dire tout ce que le dépôt a pris la peine de dériver.

4. **Zéro commande fantôme.** Les 22 `npm run …` citées existent. Sur un dépôt de cette taille,
   c'est un résultat.

5. **La distinction dépôt / production est tenue partout**, avec la marche à suivre
   (`npx vercel ls` puis `git log --oneline -1`) posée en tête de fichier. Beaucoup de dépôts
   confondent les deux sans même savoir qu'ils le font.

6. **`.env.example` (14,7 Ko, versionné) est excellent** : il explique chaque variable, documente
   la chaîne LLM correctement — *« La chaîne est Gemini → Groq → Mistral, dans cet ordre, et
   l'ORDRE EST LE CONTRAT »* — et tient à jour la liste de la config morte. Il est plus juste que
   `CLAUDE.md` sur ce point précis, et il existe même un test
   (`tests/unit/quality/env-example-completeness.test.ts`) pour le garder complet. C'est le modèle
   à généraliser.

7. **`docs/conception/` est le corpus le plus sain** : tous les en-têtes de fichier pointent vers du
   code existant, ce qui n'est pas un hasard mais le produit de l'extraction automatique du
   2026-08-20.

8. **Le réflexe d'auto-correction est réel.** `CLAUDE.md` corrige explicitement ses propres
   affirmations antérieures (« l'ancienne note … est caduque », « cette ligne annonçait deux tests
   … corrigé le 2026-08-19 »). Le défaut mesuré par cet audit n'est pas l'absence de ce réflexe,
   c'est qu'il **ajoute** au lieu de **remplacer** — d'où 172 Ko et des contradictions internes.

---

## Ce que je n'ai pas pu vérifier

- **Tout ce qui concerne la production réelle.** État des abonnements et scopes Slack, contenu de
  la Turso de production, DDL réellement appliqués, variables posées sur Vercel, présence de
  `AUTHZ_ENFORCE` et `CRON_SECRET`, désignation du manager dans `slack_directory.role`, comptes de
  lignes en base (`employees` = 2, `channel_messages` = 0, etc.). Les scripts qui le diraient
  (`probe-*`, `sync-*`, `role:set`, `apply-ddl`) touchent la production et m'étaient interdits.
  Les constats de cet audit portent donc **exclusivement sur le dépôt**.

- **Les mesures de tokens** (FLOOR par agent, « +75 tokens par aller-retour », « 2 506 → 333 »,
  « bloc STYLE 62 → 81 tokens, plafond 86 »). Elles exigent `zodToJsonSchema` + `getInstructions()`
  sur le câblage réel. `tests/unit/agents/agent-instructions-budget.test.ts` et
  `tests/unit/tools/tool-result-budget.test.ts` existent et verrouillent les **propriétés**
  (indépendance de la taille au nombre de lignes) — ce qui est le bon choix — mais pas les chiffres
  cités en prose.

- **Les mesures du bundle Vercel** (« 178 paquets, 11 696 fichiers, 64 Mo », « 264 → 160 Mo »,
  « 20 447 → 8 766 fichiers ») : elles exigent `npm run build`, hors périmètre.

- **Les latences** (« 5 229 ms à froid », « 734 ms de médiane sur dix clics signés ») : mesures de
  production. `CLAUDE.md` les assortit d'ailleurs elle-même de la bonne réserve sur le trajet
  réseau Cap-Washington.

- **Les numéros d'urgence** (`src/shared/emergency-lines.ts`). Je n'ai vérifié ni le 117, ni le 112,
  ni l'appartenance nationale du 122, du 143 et du 3114. Le fichier documente ses sources et le
  raisonnement est solide, mais **c'est le seul endroit du dépôt où une erreur peut coûter une
  vie** : cette vérification doit être refaite par un humain, auprès des sources primaires, et
  redatée.

- **Le fait que `agent-marcel/` soit bien une copie obsolète** et non un second projet légitime :
  j'ai constaté qu'il duplique l'arborescence, qu'il est gitignoré et qu'il ne contient pas les
  fichiers les plus récents (`fact-curtain.test.ts`, `model-fact-summarizer.service.ts`). Son
  intention reste à confirmer par son auteur.

- **Le contenu de `CHANGELOG.md` (307 Ko) et de `TODO.md` (102 Ko)** n'a été échantillonné que sur
  les points croisés avec `CLAUDE.md`. Une passe complète y trouverait vraisemblablement d'autres
  affirmations périmées — mais un CHANGELOG est un journal, et son contenu ancien n'a pas vocation
  à rester vrai.
