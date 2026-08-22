# Feature `document`

> Décisions de conception, extraites des commentaires du code le 2026-08-20.
> Périmètre : `src/features/document/`
>
> Chaque entrée est ancrée sur la **déclaration** qu'elle précédait, jamais sur un numéro
> de ligne : l'audit du 2026-08-21 a mesuré 5 424 ancres `L.N` dont **153 exactes (2,8 %)**.
> Un numéro de ligne se périme au premier retrait de commentaire — c'est-à-dire aussitôt.
>
> Le code ne porte plus ce texte : **c'est ici qu'il vit désormais.**

---

## `features/document/application/tools/generate-document.ts`

**Avant `import type {`**

Ports d'une AUTRE feature, importés depuis sa couche `domain`.

C'est la règle de dépendance, pas une entorse : `application` peut dépendre d'un

`domain`, y compris celui d'une feature voisine — précédent en place dans

`employee/application/tools/get-employee-profile.ts`, qui lit le port

`onboarding/domain/ports/onboarding.repository`. Redéclarer ici un troisième

`EmailProvider` (le dépôt en duplique déjà un pour `EmployeeRepository`) ferait

diverger la borne de taille des pièces jointes et la forme des uploads entre deux

features qui parlent au MÊME adaptateur.
**Avant `type DeliveryVerdict = 'slack' | 'email' | 'none' | 'failed';`**

Génération de document — outil exposé au LLM.

## Ce que l'outil fait, et pourquoi il le fait maintenant

Avant le 2026-08-11 il se réduisait à un `repo.save()` : aucun fichier n'était
produit, aucune livraison n'existait. C'est ce vide qui a fabriqué en production le
faux lien `https://kisso.internal/docs/<uuid>/download` — sommé de livrer un
document, le modèle en a inventé la seule chose qu'il savait produire, une URL.
L'outil RENVOIE désormais un fichier réel : il le rend (PDF ou DOCX), l'enregistre,
le livre, et rend compte de la livraison.

## Comment la destination est exprimée — arbitrage

Un SEUL champ énuméré, `deliverTo`. Le plafond Groq (12 000 tokens/minute) interdit
d'ajouter un tool, et chaque champ d'`inputSchema` est réémis à CHAQUE aller-retour :
trois champs (canal, thread, adresse) coûteraient plus que la capacité ne rapporte.

Surtout, ces trois champs n'ont RIEN à faire dans le schéma : le serveur les connaît
déjà mieux que le modèle.
- Le canal et le thread viennent du `requestContext` (`readSlackContext`) : le modèle
  ne voit jamais un identifiant de canal, il ne peut donc ni l'inventer ni le détourner.
- L'adresse email est résolue depuis l'annuaire à partir d'`employeeId`. C'est
  exactement le modèle de menace déjà appliqué par `send-notification.ts` : cet outil
  est atteignable depuis un message Slack arbitraire, donc toute valeur produite par le
  LLM est réputée contrôlée par un attaquant. **Une adresse fournie par le modèle ne
  serait jamais utilisée.**

Il reste au modèle le seul choix qui soit réellement le sien : où l'utilisateur veut
recevoir le document. `slack` par défaut — la demande arrive d'une conversation Slack
dans la quasi-totalité des cas, et un défaut qui oblige à demander « où veux-tu que je
l'envoie ? » coûte un aller-retour complet, soit plus cher que le champ lui-même.

## Régime d'erreur

Le document est TOUJOURS enregistré, même quand la livraison échoue. L'échec est
retourné explicitement au modèle (`delivery` + `reason` + `hint`) et journalisé en
`error` — jamais avalé. C'est la contrepartie du piège déjà documenté dans le dépôt
(`emailSent: false` sous `status: 'success'`) : dégrader sans le dire est pire que
d'échouer.

## Assainissement du contenu

`title` et `content` sont écrits INTÉGRALEMENT par le modèle et ne passaient par
aucun filtre : `sanitizeAgentOutput` n'a qu'un site d'appel, `response.text` dans le
handler Slack, et les arguments de tool n'y passent jamais. Des PDF réellement produits
imprimaient donc `kisso_<32 hex>`, `[SECURITY_BLOCK]`, `DIRECTIVE 3.1` et
`https://kisso.internal/…` en clair, sans le moindre log — un canal d'exfiltration
téléchargeable et repartageable, contournant le filet unique.

Le filtre est posé À DEUX endroits, et ce n'est pas une redondance :
  - au seuil du RENDU (`buildDocumentOutline`, couche domain), seul point que ni un
    renderer ni `documentGenerationWorkflow` ne peuvent contourner ;
  - ICI, parce que la PERSISTANCE (`documentRepo.save`) et la JOURNALISATION vivent en
    dehors du renderer. Un document enregistré avec un marqueur en base serait ressorti
    tel quel au premier code qui le relirait.
L'opération est idempotente, la double application est donc sans effet de bord.

**Avant `type DeliveryVerdict = 'slack' | 'email' | 'none' | 'failed';`**

 Verdict de livraison rendu au modèle. C'est LUI qui doit gouverner la réponse.

**Avant `const HINTS = {`**

Consignes rendues au modèle dans les cas dégradés UNIQUEMENT.

Elles ne sont pas payées dans le cas nominal : pas un caractère de plus dans le
contexte quand la livraison réussit (même arbitrage que `onboardingHint` dans
`get-employee-profile.ts`). Chacune dit au modèle ce qu'il doit ANNONCER, faute de
quoi il comble le vide — c'est la mécanique exacte du faux lien de téléchargement.

**Avant `function isMissingScope(error: unknown): boolean {`**

Reconnaît le refus `missing_scope` de Slack À TRAVERS l'enrobage de l'adaptateur.

`SlackAdapter.uploadFile` retraduit ce cas en une `Error` de prose qui nomme les deux
gestes humains requis (ajouter `files:write`, PUIS réinstaller l'app) et conserve
l'erreur d'origine dans `cause`. On inspecte donc la CHAÎNE de causes et non le seul
objet reçu : lire `err.data.error` à plat, comme le fait l'adaptateur, ne verrait
jamais rien ici.

Le repli sur le message est volontaire : c'est le seul filet si l'adaptateur cesse un
jour de propager `cause`, et se tromper coûte seulement un `hint` moins précis.

**Avant `employeeRepo: EmployeeRepository;`**

 Annuaire : alimente le gabarit ET résout l'adresse de livraison.

**Avant `renderers: readonly DocumentRenderer[];`**

Un renderer par format. Une LISTE et non une map : c'est le renderer qui déclare
son format (`DocumentRenderer.format`), donc le câblage ne peut pas se tromper de
clé — une map laisserait passer `{ pdf: new DocxService() }`.

**Avant `fileUpload?: FileUploadProvider;`**

 Absent en test ou hors Slack : la livraison dégrade au lieu d'échouer.

**Avant `interviewRepo?: OnboardingInterviewRepository;`**

Entretien post-profil, résolu CÔTÉ SERVEUR pour nourrir le gabarit.

OPTIONNEL à dessein : sans lui, le document est exactement celui d'avant. C'est ce qui
rend ce câblage sûr à ajouter — un guide reste produit même sur une base où la table
`onboarding_interview` n'a pas encore été appliquée.

**Avant `channelRepo?: { listChannels(): Promise<ReadonlyArray<{ channelId: string; name: string }>> };`**

 Résout un nom lisible depuis un identifiant `C…`. Sans lui, les canaux ne sont pas cités.

**Avant `const RENDERABLE_FORMATS = [DocumentFormat.Pdf, DocumentFormat.Docx] as const;`**

Formats réellement RENDUS, et donc les seuls exposés au modèle.

`DocumentFormat` en compte dix (`markdown`, `html`, `json`, `csv`, `xlsx`, `pptx`,
`image`, `txt`…) mais deux seulement ont un renderer. Les annoncer tous aurait deux
défauts, chacun suffisant :
  1. le schéma promettrait au modèle ce que le code ne sait pas faire — c'est la
     définition même du piège que ce lot corrige ;
  2. huit valeurs mortes sont réémises à chaque aller-retour, sous plafond Groq.
`z.enum` sérialise en `{"type":"string","enum":[…]}` — plat, donc accepté par le
validateur de tool-calls (voir `tests/unit/tools/tool-schema-flatness.test.ts`).

`execute` reste néanmoins tolérant à un format hors liste : l'outil est aussi
appelable hors Zod (appel direct, workflow, test), et un `throw` y serait un piège.

**Avant `async function readInterview(`**

Ce que la personne a dit d'elle à l'entretien, prêt pour le gabarit.

Côté SERVEUR, jamais par le modèle — et ne LÈVE jamais

Même chemin que la fiche employé : l'entretien est résolu à partir de l'`employeeId`, sans
qu'aucune de ces valeurs ne traverse la fenêtre du modèle. C'est ce qui rend un guide
personnel pour **zéro token**, là où le gabarit imprimait auparavant quatre puces écrites
en dur, identiques pour tout le monde.

⚠️ Toute indisponibilité est AVALÉE et rend `undefined`. Un guide sans section « ton
quotidien » reste un guide ; un guide qui n'existe pas parce que la table
`onboarding_interview` n'a pas encore été appliquée serait une régression franche. Même
contrat de dégradation que la mémoire conversationnelle.

Les NOMS de canaux sont résolus ici parce que la base stocke des `C…` — qui ne se lisent
pas — et qu'un canal se renomme sans que son identifiant bouge. Un identifiant non résolu
est ÉCARTÉ plutôt qu'imprimé brut : « #C0BP3RCLLA1 » dans un document d'accueil est pire
qu'une ligne en moins.

**Avant `function revisionFingerprintOf(revises: boolean | undefined, content: string): string | undefine`**

Empreinte COURTE d'un contenu, pour la seule clé de déduplication.

⚠️ Ce n'est PAS une garantie cryptographique et ça n'a pas à l'être : une collision ferait
rejeter une correction comme un doublon dans une fenêtre de dix minutes, jamais fuir quoi
que ce soit. Ce qu'on veut, c'est que deux contenus DIFFÉRENTS donnent presque toujours deux
clés différentes — et que la clé reste courte, puisqu'elle vit en mémoire.

**Avant `function byMostRecentlyUpdated(a: Document, b: Document): number {`**

Le document à CORRIGER, ou un refus — jamais un repli sur une création.

⚠️ UN SEUL VERDICT pour deux causes : « ce document n'existe pas » et « ce document
appartient à quelqu'un d'autre » se répondent à l'identique. Les distinguer ferait de ce
champ un ORACLE d'existence, un identifiant à la fois — la règle déjà écrite pour le chemin
email de `getEmployeeProfile`, qui passe l'identifiant RÉSOLU (ou `null`) à la garde pour que
le refus soit indiscernable.

⚠️ Appelé APRÈS la frontière d'autorisation et APRÈS la résolution de l'employé, jamais
avant : lire un document pour décider ensuite si l'on avait le droit de le lire, c'est
l'avoir déjà lu.

 Le plus récemment mis à jour d'abord. Comparaison de chaînes ISO : elles s'ordonnent.
**Avant `const all = await documentRepo.findByEmployee(employeeId);`**

⚠️ Le tri est fait ICI et non dans le port : ni `DrizzleDocumentRepository` ni la doublure

n'ordonnent `findByEmployee`, et un port qui ne promet pas d'ordre ne doit pas être lu

comme s'il en promettait un. Même défaut que celui corrigé sur `getNotificationHistory`,

où deux appels identiques rendaient deux ordres différents.
**Avant `logger.warn('Correction refusée — aucun document de ce type pour cette personne', {`**

⚠️ ON NE RETOMBE PAS SUR UNE CRÉATION : le modèle annoncerait « j'ai corrigé » alors

qu'il viendrait de produire un premier document. Le hint lui dit quoi faire à la place.
**Avant `async function persistDocument(`**

Enregistre le document — TOUJOURS, quel que soit le sort de la livraison.

⚠️ `update` quand on CORRIGE, `save` sinon, et l'identifiant EXISTANT dans le premier cas :
c'est toute la propriété du champ `revises`. Un UUID neuf ferait de « corrige » un synonyme
de « refais », c'est-à-dire exactement le défaut des 7 documents identiques du 2026-08-12.

Extrait de `execute` le 2026-08-19 : la correction y ajoutait cinq embranchements et portait
la complexité cognitive au-dessus du seuil, or ce dépôt est à zéro warning depuis le
2026-08-18. Le corps est déplacé à l'identique.

**Avant `createdAt: revised ? revised.createdAt : doc.createdAt,`**

`createDocument` repose un `createdAt` à l'instant présent : sur une correction, ce

serait effacer la date de production réelle du document.
**Avant `status: DocumentStatus.Generated,`**

Toujours `Generated` ici : à cet instant RIEN n'est parti. `Sent` est posé ensuite

par `markDeliveryOutcome`, et seulement si un transport a rendu la main — c'est la

seule trace persistée d'un départ réel, et la poser d'avance rejouerait exactement le

défaut `status = Sent` posé avant l'envoi, corrigé sur `sendNotification`.
**Avant `async function markDeliveryOutcome(`**

Pose `Sent` une fois — et seulement une fois — qu'un transport a réellement rendu la main.

Séparé de `persistDocument` parce que les deux répondent à des questions différentes :
l'un dit « ce document existe », l'autre « ce document est parti ». Les confondre, c'est
ce qui permettait à un statut d'être posé avant l'acte qu'il décrit.

⚠️ NE LÈVE PAS. Un échec de mise à jour laisse une ligne `Generated` pour un document
réellement livré : l'audit sous-compte, mais le destinataire a bien son fichier et rien
n'est perdu. Propager l'erreur transformerait une imprécision de trace en échec d'un tour
qui a pourtant abouti — et le modèle annoncerait une panne après une livraison réussie.

**Avant `const runGuard = makeRunGuard();`**

Une garde par INSTANCE de tool, et non par module.

En production cela ne change rien : `makeGenerateDocument` n'est appelée qu'une fois,
au câblage de `src/mastra/index.ts`, donc la garde vit aussi longtemps que le
processus — exactement la portée voulue. En test, en revanche, une garde de module
rendait les cas dépendants de leur ordre d'exécution : le deuxième test qui demandait
le même document retombait sur le résultat mémorisé par le premier. La portée utile
est assurée par la clé (conversation) et le TTL, jamais par la durée de vie de l'objet.

**Avant `inputSchema: z.object({`**

Schéma dépouillé pour le budget de tokens (voir `schedule-reminder.ts`) :

les `.describe()` qui ne faisaient que répéter le nom du champ ont été retirés.
**Avant `employeeId: uuidSchema.optional().describe('UUID annuaire — omets-le pour le demandeur'),`**

⚠️ FACULTATIF depuis le 2026-08-20, et par défaut c'est le DEMANDEUR.

Il était obligatoire, donc le modèle devait se le procurer — et le seul endroit qui

le lui donnait était `getEmployeeProfile`, qui l'imprimait ensuite dans la réponse :

« ID : d20df236-… ». Un UUID ne dit rien à un humain et fait douter du reste (« je ne

sais pas d'où il vient, s'il existe réellement ou pas »).

Le SERVEUR sait pour qui, quand personne d'autre n'est nommé : `slackEmployeeId` est

dans le `requestContext`, posé par le handler, hors de portée du modèle. C'est le même

raisonnement que pour `revises`, passé d'un UUID à un booléen le 2026-08-19 : un

identifiant qu'on demande au modèle est un identifiant qu'il peut inventer.

⚠️ Il reste EXIGÉ pour un tiers, et il reste un UUID — jamais une adresse. La

frontière `canReadPersonRecord` est inchangée : soi-même toujours, autrui au niveau

`full`. Rendre le champ facultatif ne rend rien plus permissif ; ça retire une valeur

que le modèle fabriquait.
**Avant `content: z`**

⚠️ Borne HAUTE ajoutée le 2026-08-13. `title`/`subject` étaient bornés à 200 sur la

ligne voisine, ce champ ne l'était pas — asymétrie relevée par l'audit, et c'est le

champ VOLUMINEUX. Rien en aval ne tronque : ni les assainisseurs de document ni les

adaptateurs d'envoi. Un contenu non borné est persisté, relu, et repart dans la

fenêtre du modèle, sur un système dont la contrainte dominante EST le budget de

tokens.

⚠️ LA DÉROGATION DE RÉDACTION, et elle a mis sept jours à arriver ici.

Le bilan de la série C (2026-08-11 : 7 messages, 0 email, 0 rappel, 0 document) a

établi que les outils POSAIENT les questions au lieu de faire le travail, et que le

correctif devait vivre dans le `.describe()` du champ — PAR CHAMP, jamais dans le

prompt, où il contredirait frontalement `AGENT_ANTI_INVENTION_BLOCK` (« n'invente

jamais une donnée absente : demande-la ») et reviendrait à tirer à pile ou face à

chaque tour. La ligne de partage : un email ou un UUID se RETROUVENT, une prose se

PRODUIT.

`sendNotification.body` l'a reçue le jour même. Ces deux champs-ci, non — et la

doctrine de l'époque citait `generateDocument` comme « le seul outil de la campagne

qui ait abouti », donc le modèle à copier : c'est cette formulation qui a masqué

l'oubli pendant sept jours.

Constaté en production le 2026-08-18 sur « Génère-moi le guide d'accueil en PDF » :

« Quel texte doit contenir le guide d'accueil ? Fournis-moi le contenu… ». Un

aller-retour entier perdu — poste de coût DOMINANT, ≈ 1 500 tokens sur un budget

journalier de 100 000 — pour un produit qui demandait à un arrivant de rédiger

lui-même son guide d'accueil.

⚠️ Ne PAS l'étendre à `employeeId` : un identifiant se retrouve. L'y poser

inviterait à en inventer un, ce qui est exactement le bug de destinataire du

2026-08-14 — dix documents enregistrés sous le mauvais UUID.
**Avant `.describe(`**

⚠️ RENFORCÉ le 2026-08-19 après une SECONDE mesure en production. « rédige-le, ne le

demande pas » — cinq mots, posés le 2026-08-18 — n'a pas tenu : sur « Génère-moi le

guide d'accueil en PDF », le modèle a répondu « Peux-tu me fournir le contenu ? ».

Cinq mots ne pèsent pas face à `AGENT_ANTI_INVENTION_BLOCK` (« n'invente jamais une

donnée absente : demande-la »), qui est dans le PROMPT et s'applique à tout.

La phrase nomme donc la ligne de partage plutôt que de l'énoncer : une prose se

PRODUIT, un email ou un UUID se RETROUVENT.
**Avant `format: z.enum(RENDERABLE_FORMATS).optional().default(DocumentFormat.Pdf),`**

`pdf` par défaut, et non plus `txt`. L'attente produit est un PDF ; un défaut

`txt` obligeait le modèle à deviner qu'il fallait demander autre chose, et

produisait donc des documents que personne n'avait demandés dans ce format.
**Avant `deliverTo: z.enum(['slack', 'email', 'none']).optional().default('slack'),`**

Destination — un seul champ, valeurs auto-explicites, aucun `.describe()`.

Ni canal, ni thread, ni adresse : voir le modèle de menace en tête de fichier.
**Avant `revises: z`**

⚠️ CORRIGER plutôt que REFAIRE — ajouté le 2026-08-19, et il ferme une cause écrite

dans ce fichier depuis le 2026-08-12 : « le système ne sait que CRÉER — il n'existe

aucun outil de relecture de document, donc refaire est la seule action que le modèle

puisse entreprendre ». D'où les 7 documents identiques en 8 minutes. La garde

d'idempotence a étouffé le symptôme ; ce champ referme la cause.

⚠️ UN CHAMP, JAMAIS UN SECOND TOOL : un tool de plus est un schéma de plus réémis à

CHAQUE aller-retour de l'agent qui le porte (≈ 150 tokens), un champ optionnel en

coûte une vingtaine. L'identifiant vient du tool-result précédent, que le modèle a

déjà dans sa fenêtre.

⚠️ UN BOOLÉEN, ET NON UN UUID — corrigé le 2026-08-19, quelques heures après la

première version, par une mesure en production.

Le champ attendait l'identifiant rendu par le tool-result précédent. Or la mémoire

conversationnelle de ce dépôt ne stocke QUE DU TEXTE : « jamais de tool-call ni de

tool-result ». Au message suivant — c'est-à-dire dans le seul cas qui compte, « corrige

ce guide » — le modèle n'avait donc plus l'identifiant, et il l'a demandé à l'humain :

« Pour réviser le guide, il me faut l'UUID du document existant. » Un aller-retour

perdu, et une phrase absurde adressée à quelqu'un qui n'a jamais vu d'UUID.

Le SERVEUR sait, lui : le dernier document de ce type pour cette personne. C'est la

règle appliquée partout ailleurs ici — le canal, le fil, l'adresse email et

l'identifiant du demandeur ne traversent jamais la fenêtre du modèle. Un identifiant

qu'on demande au modèle est un identifiant qu'il peut inventer.
**Avant `const slackCtx = readSlackContext(ctx?.requestContext);`**

POUR QUI — résolu AVANT tout le reste

Le champ est facultatif : absent, c'est le demandeur. Sans demandeur identifiable

NON PLUS, on renonce — et on le DIT, plutôt que de produire un document au nom de

personne. C'est le cas hors Slack (playground, workflow) et celui d'une personne dont

la ligne d'annuaire n'est reliée à aucun dossier.
**Avant `const { title, content } = sanitizeDocumentInput({`**

Assainissement — AVANT tout usage du titre et du corps

Le titre est une feuille : rien à y traduire, on l'assainit à fond. Le corps

conserve son balisage markdown, que `buildDocumentOutline` traduit ensuite en

titres, puces et paragraphes ; le retirer ici aplatirait le document.
**Avant `const { effectiveDeliverTo, dedupKey } = resolveDeliveryIntent({`**

Garde d'idempotence — un livrable par CONVERSATION, pas seulement par run

Deux incidents distincts, même correctif.

(1) 2026-08-12 19:42 UTC — un SEUL message Slack, et

    `toolCalls: ["generateDocument","findEmployeeByEmail","getEmployeeProfile",

    "generateDocument"]` : le modèle a régénéré après avoir « vérifié » l'employé.

(2) 2026-08-12 21:58–22:05 UTC — rejeu d'une conversation réelle : **7 documents

    et 3 emails identiques en 8 minutes**. À « As-tu envoyé le rapport ? », le

    modèle a REGÉNÉRÉ le guide au lieu de constater qu'il venait de l'envoyer,

    puis encore, puis encore. Cause de fond : le système ne sait que CRÉER — il

    n'existe aucun outil de relecture de document, donc refaire est la seule

    action que le modèle puisse entreprendre quand on lui demande « où en est-ce ? ».

La clé porte donc la CONVERSATION (`channel[:threadTs]`) et non le message : le

cas (2) s'étale sur plusieurs messages. Le TTL fait le reste — redemander le même

document, au même format, vers la même destination, dans les 10 minutes, n'est

jamais intentionnel ; au-delà, c'est une demande neuve et elle passe.

La clé ignore délibérément `content` : les deux appels de l'incident (1) avaient

un contenu DIFFÉRENT (15 puis 249 caractères), donc hacher les arguments complets

n'aurait rien attrapé. C'est l'identité du LIVRABLE qui compte. Elle inclut en

revanche `deliverTo` : « et envoie-le par email » après une livraison Slack est

une demande légitimement différente.

⚠️ Garde EN MÉMOIRE, donc par instance. Sur deux instances distinctes, le doublon

repasse — on retombe alors exactement sur le comportement d'avant, jamais pire.

Un store partagé coûterait une E/S Turso (Tokyo) sur un chemin déjà tendu côté ACK.
**Avant `revisionFingerprint: revisionFingerprintOf(data.revises, content),`**

⚠️ Une CORRECTION change presque toujours le contenu, jamais le titre ni le type ni

le format — c'est-à-dire aucun des composants de la clé. Sans cette empreinte, la

garde rejetterait la correction comme un doublon et le modèle annoncerait avoir

corrigé alors que rien n'aurait bougé : exactement la famille de mensonge que la

garde elle-même a été écrite pour empêcher, retournée contre son propre but.
**Avant `const sameRun = Boolean(slackCtx?.eventTs) && previous.eventTs === slackCtx?.eventTs;`**

Les deux incidents ne se diagnostiquent pas pareil : un second appel dans le

MÊME message est un défaut de raisonnement du modèle, un second appel dans un

message SUIVANT est l'utilisateur qui redemande faute d'avoir vu le fichier.
**Avant `return {`**

On rend le résultat du PREMIER appel, augmenté du fait qu'il n'y a rien à

refaire. Sans cette mention, le modèle reste devant un résultat identique au

précédent et peut conclure que son appel n'a pas abouti — c'est précisément

l'absence de « l'effet existe déjà » qui a produit les doublons.
**Avant `if (!canReadPersonRecord(ctx?.requestContext, employeeId)) {`**

Résolution de l'employé — le gabarit ET l'adresse en dépendent

Un identifiant inconnu ne produit PAS d'exception : l'AI SDK v7 réinjecte au

modèle ce qu'un tool lève, et face à un vide le modèle comble (c'est l'origine

de l'over-promise « veux-tu que je crée le profil ? »). Un résultat qui

INSTRUIT vaut mieux — même choix que `get-employee-profile.ts`.

Rien n'est enregistré dans ce cas : `documents.employee_id` porte une clé

étrangère vers `employees`, une ligne orpheline serait refusée par la base.

FRONTIÈRE D'AUTORISATION — le contournement le plus large des quatre

Relevé par la revue adversariale du 2026-08-13, APRÈS que les trois lectures RH

(`getEmployeeProfile`, `getTaskList`, `getNotificationHistory`) eurent été fermées.

Ce tool restituait exactement le même dossier par un chemin voisin, et en pire :

 1. il accepte un `employeeId` ARBITRAIRE, produit par le modèle donc par le texte ;

 2. il imprime `firstName`, `lastName`, `email`, `position` et

    `startDate` de cette personne dans le document rendu (voir `renderer.render`) ;

 3. il livre le fichier dans le canal du DEMANDEUR (`slackCtx.channel`), pas dans

    celui de la personne concernée.

Soit, en deux messages : « retrouve le profil de collegue@… » puis « génère-lui une

lettre de bienvenue » — et l'attaquant reçoit en DM un PDF TÉLÉCHARGEABLE ET

REPARTAGEABLE portant le dossier d'un collègue. Fermer les trois lectures en laissant

celle-ci ouverte n'aurait fermé qu'une porte sur deux, et pas la plus large.

⚠️ AVANT la résolution de l'employé, comme dans les trois autres : un refus qui lit

d'abord et filtre ensuite fuite par sa latence et journalise une consultation qui

n'aurait pas dû avoir lieu.

Générer un document POUR QUELQU'UN D'AUTRE reste légitime — c'est le cas d'usage

central du produit, une lettre de bienvenue est écrite par les RH. C'est exactement

pourquoi la règle est celle des trois autres et non un refus sec : soi-même toujours,

autrui au niveau `full`.
**Avant `const revision = await resolveRevisionTarget(`**

CORRECTION — on remplace une ligne, on n'en ajoute pas une seconde

⚠️ RÉSOLU APRÈS la frontière d'autorisation et APRÈS l'employé, jamais avant : lire

un document pour décider ensuite si l'on avait le droit de le lire, c'est avoir déjà

lu.

⚠️ ET LE MÊME VERDICT DANS LES DEUX CAS — « ce document n'existe pas » et « ce

document appartient à quelqu'un d'autre » se répondent à l'identique. Les distinguer

ferait de ce champ un ORACLE d'existence, un identifiant à la fois : exactement la

règle déjà écrite pour le chemin email de `getEmployeeProfile`, qui passe l'identifiant

RÉSOLU (ou `null`) à la garde pour que le refus soit indiscernable.

⚠️ ON NE RETOMBE PAS SUR UNE CRÉATION en cas d'échec. Le modèle annoncerait « j'ai

corrigé » alors qu'il vient de produire un SECOND document — la famille de mensonge

que ce dépôt traque, avec la particularité qu'ici le mensonge serait fabriqué par le

repli lui-même.
**Avant `warnIfForeignSubject(slackCtx?.employeeId, employeeId, effectiveDeliverTo);`**

TRACE — un document produit POUR AUTRUI

Aucun refus : un manager ou une RH qui produit la lettre de bienvenue d'un

arrivant est le cas d'usage NORMAL — c'est même l'objet du produit. Mais c'est

aussi le seul cas où une erreur d'`employeeId` fait partir un fichier chez

quelqu'un qui n'était pas concerné, et le relevé du 2026-08-13 montre que ça

arrive : les DIX documents de la base portent l'UUID de Karyl, dont « Bienvenue

Awa », livré à l'adresse de Karyl.

⚠️ `warn` et non `info` : c'est la ligne à chercher la prochaine fois qu'un

document semble être parti au mauvais destinataire. On journalise le fait, jamais

l'adresse — le logger masquerait de toute façon un email.

`slackCtx` a déjà été lu en tête d'`execute` : un second appel ne rendrait rien de plus.
**Avant `const { rendered, producedFormat, failure } = await renderDocument({`**

Rendu

**Avant `const generated = await persistDocument(documentRepo, {`**

Enregistrement — AVANT la livraison, et c'est l'ordre qui compte

⚠️ CORRIGÉ LE 2026-08-20. `deliver()` était appelé EN PREMIER. Le commentaire qui

suivait disait vrai — l'enregistrement a bien lieu quel que soit le VERDICT de

livraison — mais il ne disait rien de l'ORDRE, et c'est l'ordre qui décide de ce

qui survit à une mort du processus.

Sur Vercel la fonction peut être gelée ou tuée à `maxDuration` (60 s) à tout

instant. Entre les deux appels, l'état atteignable était : le PDF est réellement

dans Slack ou dans une boîte mail, et il n'existe AUCUNE ligne en base. Donc

`revises` ne retrouve plus rien, une reprise produit un SECOND document — la

famille du défaut « 7 documents et 3 emails identiques en 8 minutes » — et l'audit

sous-compte un document réellement parti.

La garde d'idempotence ne rattrape rien : `runGuard.remember` vient APRÈS les deux,

et c'est une `Map` en mémoire de processus, qui meurt avec l'instance.

L'ordre inverse a un pire cas STRICTEMENT moins coûteux : une ligne `Generated`

sans fichier livré. Elle est visible, corrigible, et `revises` sait la retrouver.

Même arbitrage que `clear()` avant l'envoi de l'email d'entretien : on prend

d'abord, on agit ensuite.

Il n'y a AUCUNE transaction dans ce dépôt — ce n'est donc pas une atomicité qu'on

gagne ici, c'est le choix du pire cas.
**Avant `title,`**

Persistance : les valeurs ASSAINIES, jamais celles du modèle. Une ligne

enregistrée avec un marqueur ressortirait telle quelle au premier code qui la

relirait — le filtre du rendu ne protège que le fichier, pas la base.
**Avant `const delivered = await deliver({`**

Livraison — aucune exception ne sort de ce bloc

**Avant `const recipient = fullName(employee.firstName, employee.lastName);`**

Tool-result — PROJETÉ, jamais l'entité

L'outil retournait l'entité COMPLÈTE, `content` compris : il renvoyait au modèle

le texte que le modèle venait d'écrire, à ses frais, et ce texte restait ensuite

dans l'historique de TOUS les tours suivants. Même défaut, même correction que

`getEmployeeProfile` (2 506 → 329 tokens, voir `task-summary.mapper.ts`).

Ne sort ici que ce dont le modèle a besoin pour formuler sa réponse : de quoi

désigner le document, le format réellement produit (il peut différer du demandé),

le nom du fichier livré — et surtout le VERDICT DE LIVRAISON, sans lequel il ne

peut pas dire la vérité. La taille ne dépend plus de la longueur du contenu.

⚠️ `recipient` — ajouté le 2026-08-14 après le relevé de production.

Les DIX documents de la Turso portent l'UUID de Karyl, y compris celui intitulé

« Bienvenue Awa » (`type=welcome_letter`, `status=sent`) : son email est donc parti

à l'adresse de Karyl. Le tool a fait exactement ce qu'on lui demandait — c'est

l'`employeeId` choisi par le modèle qui était faux, faute d'un résolveur par nom.

Ce champ ne CORRIGE rien : il rend le fait VISIBLE. Le modèle voit désormais pour

qui il vient de produire un document et le bloc DOCUMENTS lui impose de le nommer,

si bien qu'une erreur de destinataire devient lisible par l'humain au tour même,

au lieu de rester muette jusqu'à ce qu'on interroge la base un mois plus tard.

La correction, elle, est en amont : `findPersonByName`.

Le NOM, jamais l'email — pour la même raison que `findEmployeeByEmail` n'en rend

pas : ce tool est atteignable par n'importe quel membre du workspace. Coût ≈ 12

tokens, payés à chaque document produit.
**Avant `writeDocumentRecipient(ctx?.requestContext, recipient);`**

⚠️ LE DESTINATAIRE REMONTE PAR LE CONTEXTE SERVEUR, en plus du tool-result.

Le champ `recipient` du tool-result existe depuis le 2026-08-14 et le bloc DOCUMENTS

impose de le citer : c'est la mesure de VISIBILITÉ contre l'erreur de destinataire —

« Bienvenue Awa » enregistré sous l'UUID de Karyl, fichier parti à l'adresse de Karyl.

Mesuré en production le 2026-08-19 sur DEUX sondes : le modèle ne le cite pas. Une

mesure de visibilité qui ne se déclenche jamais est pire qu'absente — on la croit en

place. Le handler accole donc la note lui-même, et seulement si elle manque.

Coût en tokens : ZÉRO. Le `RequestContext` ne traverse ni le prompt, ni les schémas,

ni le tool-result.
**Avant `...(revised ? { revised: true as const } : {}),`**

⚠️ Présent UNIQUEMENT sur une correction : le bloc DOCUMENTS impose au modèle de

dire ce qui a eu lieu, et « corrigé » n'est pas « produit ». Un booléen toujours

présent coûterait ses tokens à chaque document, pour ne rien dire dans le cas

fréquent.
**Avant `if (dedupKey && (delivery === 'slack' || delivery === 'email')) {`**

Mémorisé APRÈS le succès : un premier appel qui a échoué avant l'enregistrement

ne doit pas condamner une seconde tentative du modèle. `eventTs` est conservé

pour distinguer, au prochain appel, « le modèle a rappelé le tool dans le même

message » de « l'utilisateur a redemandé » — deux défauts différents à diagnostiquer.

La livraison n'est mémorisée que si elle a ABOUTI : un envoi échoué doit pouvoir

être retenté, sinon la garde transformerait une panne passagère en refus définitif

pendant dix minutes.
**Avant `function resolveDeliveryIntent(params: {`**

Où le document doit aller, et sous quelle clé de déduplication.

⚠️ **`none` est NEUTRALISÉ dans une conversation Slack**, et ce n'est pas une commodité.
Mesuré en production le 2026-08-12 : sur « Génère un guide en PDF ET DONNE-LE MOI pour que
je puisse le télécharger », le modèle a choisi `deliverTo: 'none'`, puis a annoncé à
l'utilisateur que le document « n'est pas livré automatiquement cette fois » — la demande
explicite sous les yeux.

La valeur reste dans le schéma : elle est LÉGITIME hors Slack (workflow, playground, appel
direct), où il n'y a personne à qui livrer. Mais dans une conversation, un document que
personne ne reçoit n'est jamais ce qui a été demandé — c'est une porte de sortie offerte au
modèle, pas une intention d'utilisateur.

**Avant `let conversationKey: string | undefined;`**

Même clé que `deriveConversationId` : en DM `threadTs` est absent par conception,

donc le canal EST la conversation.
**Avant `const effectiveDeliverTo =`**

`none` est NEUTRALISÉ dans une conversation Slack — correctif du 2026-08-12

Mesuré en production : sur « Génère un guide en PDF **et donne-le moi pour que je

puisse le télécharger** », le modèle a choisi `deliverTo: 'none'`, puis a annoncé

à l'utilisateur que le document « n'est pas livré automatiquement cette fois » —

en ayant la demande explicite sous les yeux.

La valeur n'est pas retirée du schéma : elle est LÉGITIME hors Slack (workflow,

playground, appel direct), où il n'y a personne à qui livrer. Mais à l'intérieur

d'une conversation Slack, un document que personne ne reçoit n'est jamais ce qui

a été demandé — c'est une porte de sortie offerte au modèle, pas une intention

d'utilisateur. On livre donc dans le fil d'où vient la demande.
**Avant `const dedupKey = buildRunKey(conversationKey, 'generateDocument', [`**

Hors Slack, `buildRunKey` rend `undefined` et la garde est INACTIVE : le

playground, les workflows et les tests ne sont bornés par aucune conversation.
**Avant `function warnIfForeignSubject(`**

Assainit le titre et le corps AVANT tout usage, et journalise ce qui a été retiré.

⚠️ Le titre est une feuille : rien à y traduire, on l'assainit à fond. Le corps CONSERVE
son balisage markdown, que `buildDocumentOutline` traduit ensuite en titres, puces et
paragraphes — le retirer ici aplatirait le document.

⚠️ Les deux `logger.error` restent DANS cette fonction, sur le chemin nominal : ce sont les
seules détections d'exfiltration par document du dépôt. Un marqueur interne dans un
livrable téléchargeable signifie que le modèle a écrit son propre garde-fou dans un fichier
qui sort de l'entreprise ; il n'existait aucune ligne pour le voir avant le 2026-08-11.

POUR QUI ce document est-il produit ?

Le champ est facultatif depuis le 2026-08-20 : absent, c'est le DEMANDEUR, résolu côté
serveur. Extraite en fonction parce que le corps d'`execute` est déjà au plafond de
complexité que ce dépôt tient à zéro warning — et parce que la règle tient en une ligne,
qui se lit mieux nommée qu'inline.

Journalise qu'un document est produit pour QUELQU'UN D'AUTRE que le demandeur.

⚠️ `warn` et non `info` : c'est la ligne à chercher la prochaine fois qu'un document semble
être parti au mauvais destinataire. On journalise le FAIT, jamais l'adresse — le logger
masquerait de toute façon un email.

Ce n'est PAS un refus : produire un document pour un tiers est le cas d'usage central du
produit, c'est `canReadPersonRecord` qui en décide. Mais c'est le seul cas où une erreur de
cible fait partir un fichier chez quelqu'un qui n'était pas concerné, et le relevé du
2026-08-13 montre que ça arrive : les DIX documents de la base portaient le même UUID, dont
un « Bienvenue Awa » livré à l'adresse de quelqu'un d'autre.
**Avant `const NO_SUBJECT_RESULT = {`**

Ni personne désignée, ni demandeur résolvable — on renonce, et on le DIT.

C'est le cas hors Slack (playground, workflow) et celui d'une personne dont la ligne
d'annuaire n'est reliée à aucun dossier. Produire un document au nom de personne serait
pire qu'un refus : il partirait quand même, avec un gabarit vide là où il devrait y avoir
un nom.

**Avant `logger.error('Document content carried internal markers — markers removed', {`**

`error`, comme dans le handler Slack : un marqueur interne dans un DOCUMENT

signifie que le modèle a écrit son propre garde-fou dans un livrable

téléchargeable. C'est la ligne qui manquait pour détecter une exfiltration

par document — il n'en existait aucune.
**Avant `logger.error('Document content carried fabricated links — links removed', {`**

Seuls les HÔTES : le chemin d'un lien fabriqué embarque un identifiant réel

(celui du 2026-08-11 portait le vrai `Document.id`).
**Avant `const title = safeTitle.text.length > 0 ? safeTitle.text : DEFAULT_TITLES[data.type];`**

Le titre assaini peut être VIDE (un titre qui n'était qu'un emoji, ou qu'un lien

fabriqué). On retombe alors sur le titre par défaut du type — le même que celui

que le gabarit aurait choisi — plutôt que d'enregistrer une chaîne vide et de

livrer un fichier nommé `document.pdf`.
**Avant `async function renderDocument(params: {`**

Produit le fichier — ou dit pourquoi il n'a pas pu.

⚠️ **Ne LÈVE jamais.** Le texte du document est déjà écrit à ce stade et sera enregistré
quoi qu'il arrive : un échec de rendu ne doit pas le perdre. Le verdict porte l'échec sous
`failure`, l'appelant décide.

⚠️ Le repli sur PDF n'est PAS atteignable par le chemin Zod — le schéma n'expose que `pdf`
et `docx`, qui ont tous deux un renderer. Il existe pour les appelants hors LLM (workflow,
appel direct), à qui un échec sec sur une valeur que le schéma n'expose plus serait un
piège. Et le format RENDU est celui réellement produit, jamais celui demandé : sinon la
base annoncerait un `csv` là où un PDF a été livré.

**Avant `const renderer =`**

Rendu

Repli sur PDF quand le format demandé n'a pas de renderer : l'utilisateur reçoit

un fichier réel plutôt que rien, et le résultat NOMME le format effectivement

produit — le modèle peut donc dire la vérité (« je te l'ai fait en PDF »). Un

échec sec sur une valeur que le schéma n'expose même plus serait un piège pour

les seuls appelants hors LLM.
**Avant `logger.error('Aucun renderer disponible — document enregistré sans fichier', {`**

Câblage incomplet : on enregistre quand même, on ne perd pas le texte produit.

**Avant `position: employee.position,`**

`?? undefined` : le gabarit distingue « absent » de « vide ». Un `null` qui

traverserait finirait imprimé tel quel dans un PDF signé de l'entreprise.
**Avant `const producedFormat = rendered ? (renderer?.format ?? format) : format;`**

Le format ENREGISTRÉ est celui réellement produit, jamais celui demandé : sinon

la base annoncerait un `csv` là où un PDF a été livré.
**Avant `type DeliveryIntent = 'slack' | 'email' | 'none';`**

Où le document doit aller. Volontairement plus étroit que `DeliveryVerdict` : c'est une
INTENTION, elle ne peut pas valoir `failed`.

**Avant `interface DeliveryOutcome {`**

 Le couple rendu par toutes les étapes de livraison : où c'est parti, et pourquoi sinon.

**Avant `function toVerdict(sent: { ok: true } | { ok: false; reason: HintKey }): DeliveryOutcome {`**

 Traduit le résultat d'un envoi email en verdict de livraison.

**Avant `async function deliverToSlack(params: {`**

Livraison Slack, avec son repli email.

⚠️ **Le repli se déclenche sur TOUT échec Slack**, et c'est un correctif à ne pas
re-restreindre. Il ne portait que sur `missing_scope` — or les logs de production du
2026-08-11 prouvent que le scope `files:write` EST accordé
(`{"filename":"guide-….pdf","hasPermalink":true}`). La condition était donc devenue du CODE
MORT : `not_in_channel`, un 5xx Slack ou un réseau coupé donnaient `delivery: 'failed'` sec,
sans qu'aucun repli ne soit tenté, alors qu'un fichier réel était prêt et qu'une adresse
d'annuaire était connue.

L'argument d'origine — « ne pas écrire à quelqu'un qui n'a rien demandé » — ne tient pas
ici : le destinataire est l'employé concerné par le document, qui vient précisément d'être
demandé, et l'alternative n'est pas « ne rien envoyer » mais « perdre le document ».

Le verdict reste honnête : `email` seulement si l'envoi a réussi, et `reason` nomme toujours
`missing_scope` quand il est en jeu — c'est la seule cause qui appelle un geste humain.

**Avant `logger.info('Document livré dans Slack', {`**

Le permalink est journalisé, JAMAIS retourné au modèle : le fichier est déjà dans le

fil, et remettre une URL dans le contexte rouvrirait la porte par laquelle le faux lien

de téléchargement est passé.
**Avant `async function deliver(params: {`**

La LIVRAISON, et rien d'autre : Slack, email, ou le repli de l'un vers l'autre.

⚠️ Extraite le 2026-08-18. C'était le nœud de complexité de `execute` — trois branches, un
`try/catch`, un repli, et deux variables mutables (`delivery`, `reason`) qui traversaient
tout le reste de la fonction. Rendre un couple `{ delivery, reason }` les supprime et rend
le repli testable seul.

⚠️ **AUCUNE exception ne sort d'ici**, et c'est le contrat : le document est déjà rendu à ce
stade, et une livraison ratée ne doit jamais empêcher son enregistrement. Le verdict porte
l'échec, il ne le lève pas.

**Avant `if (effectiveDeliverTo === 'email') {`**

Email demandé explicitement : un seul chemin, sans repli — il n'y a rien vers quoi se

replier.
**Avant `if (!slackCtx) {`**

Slack demandé, mais sans canal : cas NORMAL, pas une panne — playground Mastra, route

HTTP, workflow, test. Il n'y a personne à qui livrer, on le dit, on n'échoue pas.
**Avant `async function uploadToSlack(`**

 Livraison Slack. Lève — l'appelant décide du repli.

**Avant `return await fileUpload.uploadFile({`**

`threadTs` n'est posé que s'il existe : en DM il est `undefined` PAR CONCEPTION, et

threader un DM enfouit le fichier hors de la conversation principale.
**Avant `async function deliverByEmail(`**

Livraison email. Ne lève JAMAIS : elle sert aussi de repli à la livraison Slack, et un
repli qui explose transformerait une dégradation en panne.

L'adresse vient de l'annuaire, jamais du modèle (voir le modèle de menace en tête).

## `features/document/domain/ports/document-renderer.ts`

**Avant `export interface RenderedDocument {`**

Rendu binaire d'un document.

`Uint8Array` et non `Buffer` : `Buffer` est un type Node, et la couche `domain`
doit rester du TypeScript pur (garde-fou `tests/unit/quality/architecture.test.ts`).
Les implémentations rendent en pratique un `Buffer`, qui EST un `Uint8Array` —
la contrainte ne coûte donc rien au runtime et garde le port transportable.

**Avant `filename: string;`**

 Nom sûr, déjà assaini : il part chez Slack et en pièce jointe email.

**Avant `content: string;`**

 Corps libre rédigé par l'agent — potentiellement multi-paragraphes.

**Avant `position?: string;`**

⚠️ `department` a été RETIRÉ le 2026-08-20 : aucun gabarit ne l'imprime plus, à la

demande du propriétaire. Le laisser dans cette signature en aurait fait un champ que

le prochain lecteur croirait rendu quelque part — c'est le raisonnement qui tient déjà

`isAdmin` hors d'`AccessSubject`.
**Avant `interview?: {`**

Ce que la personne a dit d'elle à l'entretien post-profil.

⚠️ Résolu CÔTÉ SERVEUR par `generateDocument`, exactement comme `employee` — jamais par
le modèle. C'est ce qui rend un guide personnel SANS coûter un token : le gabarit imprime
de la matière réelle, là où il imprimait auparavant quatre puces écrites en dur
(« Configuration poste de travail », « Accès Slack/GitHub »…) identiques pour tout le
monde. C'est le « document générique » signalé par le propriétaire.

Chaque champ est OPTIONNEL et n'est rendu que s'il existe : un intertitre suivi du vide
se lit comme un oubli, pas comme une absence de réponse. Les trois champs de l'entretien
sont eux-mêmes facultatifs.

**Avant `dailyWork?: string;`**

 Ce que la personne fait au quotidien, texte assaini à la saisie.

**Avant `workStyle?: string;`**

 Comment elle préfère travailler, texte assaini à la saisie.

**Avant `channels?: readonly string[];`**

 NOMS des canaux qu'elle a choisis — pas les `C…`, qui ne se lisent pas.

**Avant `export interface DocumentRenderer {`**

Un renderer par format. Le choix du format se fait en sélectionnant
l'implémentation, jamais en passant un drapeau : ainsi le contenu produit est
gouverné par un seul et même modèle logique (voir `domain/services/document-template.ts`).

## `features/document/domain/ports/employee.repository.ts`

**Avant `export interface EmployeeRepository {`**

Port employé PROPRE à la feature `document` — il duplique délibérément celui de la feature
`employee` : chaque feature possède ses propres ports, et ce dédoublement est documenté
comme intentionnel dans `CLAUDE.md`.

Il est aussi plus ÉTROIT : un document a besoin de nommer et de situer une personne, pas de
connaître son statut, son manager ni ses horodatages.

## `features/document/domain/services/document-file.ts`

**Avant `export const FALLBACK_DOCUMENT_BASENAME = 'document';`**

Nom de fichier et type MIME d'un document rendu.

Ces deux valeurs SORTENT du processus : le nom devient celui du fichier posté
dans Slack et celui de la pièce jointe email. Un titre est rédigé par un LLM à
partir d'un texte utilisateur — il peut donc contenir n'importe quoi, y compris
`../`, un `/`, un `\0` ou une chaîne vide. On ne fait pas confiance au titre :
on en dérive un nom, on ne le reprend jamais tel quel.

 Repli quand le titre est vide ou entièrement filtré — jamais de chaîne vide.
**Avant `const MAX_BASENAME_LENGTH = 80;`**

Longueur maximale de la base du nom. eCryptfs plafonne à 143 octets et
plusieurs clients mail tronquent au-delà de 100 : 80 laisse de la marge à
l'extension tout en gardant un nom lisible.

**Avant `export function documentMimeType(format: DocumentFormat): string {`**

 Type MIME du format, ou `application/octet-stream` faute de mieux.

**Avant `export function buildDocumentFilename(title: string, format: DocumentFormat): string {`**

Dérive un nom de fichier sûr d'un titre libre.

La liste est BLANCHE (`[a-z0-9]` après translittération), jamais noire : une
liste noire laisserait passer tout ce qu'on n'a pas anticipé — séparateurs
exotiques, RTL override, caractères de contrôle. Les accents sont décomposés
(NFD) puis leurs diacritiques retirés, pour que « Émilie » donne « emilie »
plutôt que de disparaître.

**Avant `.replace(/[\u0300-\u036f]/g, '')`**

Diacritiques Unicode combinants : classe explicite plutôt que `\p{M}`, les

classes Unicode étant proscrites ailleurs dans le projet (Zod 3.25.76).
**Avant `.replace(/^-+|-+$/g, '')`**

Les trois motifs de tirets ci-dessous sont signalés comme super-linéaires, et ils le

sont : `-+` suivi d'une ancre revient en arrière tiret par tiret. Ils s'appliquent

pourtant à un titre de document, borné par `MAX_BASENAME_LENGTH` juste après — et

mesurés à 0,03 ms sur 8 000 caractères de tirets, soit très au-delà de toute entrée

possible ici. Voir `tests/unit/security/llm-guardrail-redos.test.ts` pour la méthode.
**Avant `.replace(/-+$/g, '');`**

La troncature peut recréer un tiret terminal.

**Avant `return `${basename}.${format}`;`**

La valeur de l'enum EST l'extension attendue (`pdf`, `docx`, `txt`…).

## `features/document/domain/services/document-template.ts`

**Avant `export type DocumentBlock =`**

Modèle logique d'un document, indépendant du format de sortie.

POURQUOI CETTE COUCHE. Les templates existaient en dur dans le service pdfmake,
sous forme de `TDocumentDefinitions`. Dupliquer cette logique pour DOCX aurait
garanti la dérive : deux rendus du même type de document auraient fini par ne
plus dire la même chose. Ici, chaque renderer traduit la MÊME liste de blocs
dans sa propre grammaire — le choix du format est un choix de rendu, jamais de
contenu.

Les blocs sont volontairement pauvres (titre, paragraphe, puces, champs) :
c'est le dénominateur commun que PDF et DOCX savent tous deux rendre sans
approximation.

**Avant `export const DEFAULT_TITLES: Record<DocumentType, string> = {`**

 Titre de repli par type, quand l'appelant n'en fournit pas (cas de `generate()`).

**Avant `const HEADING_LINE = /^[ \t]{0,8}(#{1,6})[ \t]+(.*)/;`**

Traduction du markdown produit par le LLM vers le modèle logique.

AVANT : le corps libre était simplement découpé en paragraphes, donc `**`,
`#`, `---` et `|` s'imprimaient LITTÉRALEMENT dans le PDF livré — et
`splitParagraphs` faisait même de `---` un paragraphe à lui seul. Le modèle
écrit du markdown quoi qu'on lui demande (la consigne « pas de markdown » a
été démentie en production, sur les trois agents) : le seul recours est de le
traduire.

On TRADUIT plutôt qu'on ne RETIRE, parce que les blocs cibles existent déjà et
sont rendus à l'identique par les deux renderers : un `#` devient un titre, un
`- ` une puce, un tableau à deux colonnes un bloc `fields`. Retirer le
balisage aurait aplati toute la structure en un pavé, ce qui est le défaut
d'origine sous une autre forme. Ce qui n'a pas d'équivalent (séparateur
horizontal, barres résiduelles, emphase en ligne) est retiré au seuil du rendu
par `sanitizeDocumentText`.

L'indentation de tête est BORNÉE à 8 caractères dans tous ces motifs. Un `[ \t]*`

non borné rend le moteur quadratique sur une ligne entièrement blanche — et ces

motifs s'appliquent ligne à ligne à une sortie de LLM de taille non bornée.

Pas d'ancre `$` finale non plus : appliqués à UNE ligne, `(.*)` va déjà jusqu'au

bout, et l'ancre n'ajoutait qu'une source de retour arrière.

 `# Titre` … `###### Titre`. Le niveau markdown ne survit pas : voir plus bas.
**Avant `const BULLET_LINE = /^[ \t]{0,8}(?:[-*+]|\d{1,3}[.)])[ \t]+(.*)/;`**

 `- item`, `* item`, `+ item`, `1. item`, `2) item`.

**Avant `const HORIZONTAL_RULE = /^[ \t]{0,8}([-*_])\1{2,}[ \t]{0,8}$/;`**

 `---`, `***`, `___` — séparateur horizontal, sans équivalent dans un document.

**Avant `const TABLE_LINE = /^[ \t]{0,8}\|/;`**

 Ligne de tableau markdown : elle commence par une barre.

**Avant `const CODE_FENCE = /^[ \t]{0,8}```/;`**

 Clôture de bloc de code : le balisage part, le contenu reste du texte.

**Avant `function isTableDivider(row: string): boolean {`**

Ligne d'alignement d'un tableau (`|---|:--:|`) : structurelle, jamais rendue.

Balayage caractère par caractère plutôt qu'une regex `[…]+$`, qui serait
super-linéaire par retour arrière sur une longue ligne de tirets.

**Avant `function tableCells(line: string): string[] {`**

 Cellules d'une ligne de tableau markdown, barres de bord retirées.

**Avant `function tableBlocks(rows: string[]): DocumentBlock[] {`**

Traduit un groupe de lignes de tableau.

Deux colonnes → bloc `fields`, la forme que PDF et DOCX rendent tous deux
proprement. Toute autre largeur → des puces, une ligne par entrée : un tableau
à cinq colonnes rendu en `fields` mentirait sur les données en n'en gardant
que deux.

**Avant `export function splitParagraphs(content: string): string[] {`**

Découpe le corps libre en paragraphes.

Le `content` vient d'un LLM : il arrive avec des lignes vides, des retours
simples, parfois des `\r\n`. Le coller en un seul bloc produisait un pavé
illisible ; on sépare sur les lignes vides, et à défaut sur les retours simples
(un modèle qui n'a produit aucune ligne vide a quand même structuré son texte).

Conservé et exporté : c'est le repli de {@link parseContentBlocks} pour tout ce
qui n'est pas du balisage — un texte sans markdown traverse donc exactement le
même chemin qu'avant.

**Avant `export function parseContentBlocks(content: string): DocumentBlock[] {`**

Corps libre → blocs. Analyse ligne à ligne, coût linéaire.

Les titres du corps sont TOUS de niveau 2, quel que soit le nombre de `#` :
le niveau 1 est déjà pris par le titre du document, et un `#` produit par le
modèle au milieu d'un corps ne prétend pas rivaliser avec lui.

**Avant `function recipientName(input: DocumentRenderInput): string {`**

 Le nom de la personne concernée par le document. Voir `shared/name-matching.ts`.

**Avant `function recipientBlocks(input: DocumentRenderInput): DocumentBlock[] {`**

La ligne qui dit À QUI le document s'adresse.

⚠️ Elle DISPARAÎT quand le nom est inconnu, plutôt que d'imprimer « Document destiné à  »
ou un « N/A ». C'est la règle constante des gabarits de ce dépôt : un champ absent fait
disparaître sa phrase — celle qui a fait retirer « en tant que N/A » d'une lettre de
bienvenue signée de l'entreprise.

⚠️ Le NOM, jamais l'email ni l'identifiant. Un document circule : il est uploadé dans Slack,
parfois envoyé en pièce jointe, et il est repartageable. Y imprimer une adresse en ferait un
vecteur de diffusion de donnée personnelle, et un UUID n'apprendrait rien à qui le lit.

**Avant `function bodyBlocks(input: DocumentRenderInput): DocumentBlock[] {`**

 Blocs du corps libre, ajoutés à la fin de chaque template.

**Avant `rows: [`**

⚠️ La ligne « Département » a été RETIRÉE le 2026-08-20, à la demande du

propriétaire : « les départements ne doivent plus apparaître ». Elle n'était déjà

émise que si la valeur existait — le champ n'est plus collecté depuis le 2026-08-13 —

mais un champ qu'on n'alimente plus finit toujours par ressortir sur les lignes

anciennes, et c'est ce qui s'est produit.
**Avant `const positionClause = employee.position ? ` en tant que ${employee.position}` : '';`**

⚠️ Le POSTE suit désormais la même règle que le département, et il ne la suivait pas :

`employee.position ?? 'N/A'` produisait « en tant que N/A » dans une lettre signée de

l'entreprise et adressée à un arrivant — exactement ce que le commentaire d'à côté

condamnait, deux lignes plus bas. `welcome-email.ts` avait déjà corrigé ce défaut :

un champ absent fait disparaître sa phrase, jamais apparaître un « N/A ».
**Avant `const startDay = formatFrenchDay(employee.startDate);`**

⚠️ La date était imprimée BRUTE : « ta date de début est le 2026-09-01T00:00:00.000Z ».

Troisième écriture d'un formatage de date dans ce dépôt, et la seule fausse — d'où

`shared/french-date.ts`, qui la rend une bonne fois.
**Avant `{ kind: 'paragraph', text: `Bonjour ${recipientName(input)},` },`**

⚠️ TUTOIEMENT, comme partout ailleurs. Cette lettre vouvoyait (« Cher(e) », « Votre

date ») alors que le guide produit par le MÊME bot, pour la MÊME personne, dit « Ton

quotidien » et « Ta façon de travailler ». Un salarié qui reçoit les deux voit deux

expéditeurs. L'exception reste `interview-email.ts`, qui vouvoie un candidat EXTERNE —

un candidat n'est pas un collègue.
**Avant `text: `Ravis de t'accueillir chez Kisso Industries${positionClause}.`,`**

Le département a disparu de cette phrase le 2026-08-20 — voir `buildContract`.

**Avant `...(startDay`**

La phrase entière disparaît quand la date est inconnue — plutôt qu'un « à confirmer »

qui promet une confirmation que personne n'enverra.
**Avant `...interviewBlocks(input),`**

⚠️ Le bloc « Prochaines étapes » a été RETIRÉ le 2026-08-14, et ce n'est pas une

simplification : il MENTAIT. Ses quatre puces étaient écrites en dur, donc

identiques pour tout le monde, et deux d'entre elles renvoyaient à des choses qui

n'existent pas — « Remplir le questionnaire d'intégration » (aucun questionnaire

n'est envoyable ni remplissable, cf. `generate-questionnaire.ts`) et « Consulter le

guide onboarding » (aucune URL de téléchargement n'existe dans ce système).

« Rejoindre les canaux Slack assignés » est parti avec le suivi de tâches.

Ce qui reste est ce que le dossier sait RÉELLEMENT — y compris, depuis le 2026-08-14,

ce que la personne a dit d'elle à l'entretien — plus le corps rédigé par le modèle.

Une lettre plus courte et vraie vaut mieux qu'une liste qui donne des instructions

impossibles à un arrivant.
**Avant `function interviewBlocks(input: DocumentRenderInput): DocumentBlock[] {`**

Ce que la personne a dit d'elle à l'entretien post-profil, rendu en blocs.

Pourquoi c'est le GABARIT qui l'imprime, et non le modèle

L'alternative était d'exposer l'entretien au modèle pour qu'il en tire une prose. Écartée
pour trois raisons, dont la dernière suffirait :

 1. **Coût.** Il faudrait soit un tool de plus (schéma repayé à CHAQUE aller-retour de
    chaque message, sur un budget de ≈ 19 messages/jour), soit ces textes dans la fenêtre
    du modèle. Ici : zéro token.
 2. **Fidélité.** Le modèle reformulerait. Ce que la personne a écrit sur elle-même n'a pas
    à être réécrit par une machine dans un document qui porte son nom.
 3. **Vérité.** Un gabarit ne peut pas halluciner. C'est la même raison qui fait imprimer
    `position` ici plutôt que d'espérer que le modèle le recopie.

Le `content` rédigé par le modèle vient s'AJOUTER à ces blocs, il ne les remplace pas : la
chaleur vient de la prose, la véracité du gabarit.

⚠️ Chaque section n'est émise que si son champ existe. Les trois champs de l'entretien sont
facultatifs, et un intertitre suivi du vide se lit comme un oubli — le défaut exact qui a
fait retirer « Département : N/A » de la lettre de bienvenue.

**Avant `{ kind: 'bullets', items: channels.map((name) => `#${name}`) },`**

Le `#` est rendu ICI et non stocké : c'est une convention d'AFFICHAGE Slack, et la

base garde les identifiants `C…`, qui ne se lisent pas.
**Avant `...recipientBlocks(input),`**

⚠️ LE DESTINATAIRE, NOMMÉ DANS LE DOCUMENT — ajouté le 2026-08-20 à la demande du

propriétaire : « le contenu du document doit préciser à qui il s'adresse ».

Le guide était le seul gabarit à ne nommer PERSONNE : le contrat porte « Employé : … »

et la lettre ouvre sur « Bonjour … », mais le guide commençait par son titre. C'est

pourtant le document le plus produit du système, et un fichier qui circule dans Slack

sans porter le nom de la personne qu'il concerne est exactement ce qui a permis, le

2026-08-13, qu'un « Bienvenue Awa » soit livré à quelqu'un d'autre sans que personne

ne le voie. La note accolée à la réponse Slack (`buildRecipientNotice`) ne suit pas le

fichier ; celle-ci, si.
**Avant `...(employee.position`**

Le département a disparu de ce gabarit le 2026-08-20 — voir `buildContract`.

Le poste, lui, est TOUJOURS connu (`employees.position` est `NOT NULL`) et il est la

seule chose qui distingue le guide d'une personne de celui d'une autre. L'écrire ici

évite que le modèle ait à le recopier dans `content` — et qu'il l'oublie.
**Avant `...interviewBlocks(input),`**

⚠️ Les quatre puces « Configuration poste de travail / Accès Slack-GitHub /

Présentation équipe / Culture entreprise » ont été RETIRÉES le 2026-08-14. Écrites en

dur, elles sortaient à l'identique dans le guide de CHAQUE personne, quel que soit son

poste, et ne renvoyaient à aucune procédure existante : c'est exactement le

« document générique » signalé par le propriétaire.

Le contenu utile vient de DEUX sources, dans cet ordre : ce que la personne a dit

d'elle à l'entretien (matière réelle, imprimée telle quelle), puis la prose du modèle.

Un gabarit ne doit porter que ce que le CODE sait — le reste, il l'invente.
**Avant `function buildGeneric(input: DocumentRenderInput): DocumentBlock[] {`**

Template GÉNÉRIQUE : titre + corps libre.

Indispensable, et non un simple filet : `generateDocument` expose les NEUF
valeurs de `DocumentType` au modèle, alors que quatre seulement ont un template
dédié. Sans ce repli, une demande d'avenant, de politique interne ou de
document « other » échouerait au rendu — c'est-à-dire dans la moitié des cas.
C'est de surcroît le cas d'usage NORMAL : quand un agent rédige lui-même un
document, tout le contenu est dans `content` et aucun gabarit n'a de sens.

**Avant `...recipientBlocks(input),`**

Même raison que dans `buildGuide` : c'est le gabarit de repli, donc celui qui sert dans

la moitié des cas, et il ne nommait personne du tout.
**Avant `function clean(text: string): string {`**

 Texte feuille assaini. Seule la valeur est retenue ici — voir le commentaire
de `buildDocumentOutline` pour la journalisation, qui appartient à l'appelant.

**Avant `function sanitizeBlock(block: DocumentBlock): DocumentBlock | undefined {`**

Assainit un bloc, ou le laisse tomber s'il ne reste rien à rendre.

Un bloc vidé par l'assainissement (un paragraphe qui n'était qu'un emoji, une
puce qui n'était qu'un lien fabriqué) doit disparaître : le garder produirait
une ligne vide ou une puce sans texte, c'est-à-dire une trace visible du
filtrage dans un document signé de l'entreprise.

**Avant `case 'heading':`**

`heading` et `paragraph` partagent le traitement : un seul champ textuel,

et le reste du bloc (`level`, `italic`) est reconduit tel quel.
**Avant `export function buildDocumentOutline(input: DocumentRenderInput): DocumentOutline {`**

Modèle logique du document, quel que soit le format de sortie visé.

⚠️ **C'est ici que passe l'assainissement du contenu, et c'est délibéré.**
Le seuil du rendu est le SEUL point qu'aucun chemin ne contourne : les deux
renderers (`PdfmakeService.render`, `DocxService.render`) l'appellent, et
`PdfmakeService.generate()` — le chemin historique de
`documentGenerationWorkflow`, qui ne passe PAS par le tool `generateDocument`
— l'appelle aussi. Assainir uniquement dans le tool aurait laissé le workflow
dehors ; assainir uniquement ici aurait laissé la PERSISTANCE dehors, puisque
c'est le tool qui écrit en base. Les deux le font donc, et l'opération est
idempotente (voir `sanitizeDocumentText`).

Aucune journalisation ici : la couche `domain` ne dépend de rien. Le signal
remonte à l'appelant, qui journalise en `error` — exactement comme le handler
Slack le fait pour `sanitizeAgentOutput`.

**Avant `blocks: blocks.length > 0 ? blocks : [{ kind: 'paragraph', text: '' }],`**

pdfmake refuse un `content` vide : on garantit au moins un bloc.

## `features/document/domain/services/printable-text.ts`

**Avant `export interface GlyphSource {`**

CE QUE LA POLICE SAIT ÉCRIRE — et ce qu'elle imprimerait en carré.

Le défaut, signalé par le propriétaire : « des caractères indésirables sont
apparus dans les documents »

Roboto est la SEULE police injectée dans le VFS de pdfmake. Tout code point qu'elle ne
connaît pas s'imprime en `.notdef` — le carré. Le dépôt s'en protégeait déjà, mais par une
LISTE DE PLAGES écrite à la main :

    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\u{FE0F}|\u{200D}/gu

Question posée à la police elle-même, sur un échantillon de 151 caractères que le modèle
écrit réellement en français : **quatre passaient au travers.**

  • `→` U+2192, `⇒` U+21D2, `↦` U+21A6 — les flèches. Hors de toutes les plages, et un
    modèle en écrit dès qu'il décrit une séquence (« étape 1 → étape 2 »).
  • **U+202F, l'espace fine insécable** — et c'est celui qui compte. La typographie
    française l'insère devant `!`, `?`, `;`, `:` et à l'intérieur des guillemets ; `Intl`
    l'émet dans les nombres et les heures. Elle est INVISIBLE dans un `console.log`, dans un
    diff, dans une revue — et elle s'imprime en carré. Un caractère qu'on ne peut pas voir
    dans le texte source et qu'on voit dans le PDF : c'est la définition du défaut signalé.

── POURQUOI ON NE RALLONGE PAS LA LISTE ────────────────────────────────────
Ce serait la quatrième liste tenue à la main de ce dépôt, et les trois précédentes ont
toutes divergé du réel (`WIRING`, `_measure.mts`, les instructions nommant des tools
retirés). Une liste de plages ne peut pas suivre le vocabulaire d'un modèle.

On INVERSE donc la question : au lieu d'énumérer ce qui casse, on demande à la police ce
qu'elle sait rendre. Un caractère exotique de plus dans le vocabulaire du modèle ne peut
plus jamais produire un carré — il sera simplement inconnu de la police, donc traité.

── TypeScript PUR ──────────────────────────────────────────────────────────
La police est une affaire d'INFRASTRUCTURE : ce module reçoit un prédicat et ne connaît ni
pdfmake, ni fontkit, ni Roboto. C'est ce qui le rend éprouvable sans charger 3 Mo de TTF.

 Ce que la couche de rendu sait dire de sa police.
**Avant `const FALLBACKS: Readonly<Record<number, string>> = {`**

Remplacements pour les caractères sans glyphe dont l'ABSENCE se verrait.

⚠️ Ce n'est PAS la détection — celle-ci vient de la police. C'est le repli, et il ne porte
que sur les cas où supprimer produirait une phrase abîmée :

  • une flèche retirée de « étape 1 → étape 2 » donne « étape 1 étape 2 », qui a perdu son
    sens ; `->` le garde, et personne ne lit ça comme une trace de filtrage ;
  • une espace insécable retirée COLLE les mots (« 12 h » → « 12h », « Karyl : » → « Karyl: »).
    L'espace ordinaire est le repli exact : même largeur à l'œil, glyphe garanti.

Tout le reste — emojis, symboles décoratifs — est SUPPRIMÉ sans substitution. Le dépôt a
déjà tranché ce point pour les emojis : « [emoji] » rendrait visible, dans un document
d'accueil, une trace de filtrage, là où l'absence se lit comme une phrase normale.

**Avant `0x21d2: '=>',`**

→

**Avant `0x21a6: '->',`**

⇒

**Avant `0x2190: '<-',`**

↦

**Avant `0x2194: '<->',`**

←

**Avant `0x202f: ' ',`**

↔

**Avant `0x2007: ' ',`**

espace fine insécable

**Avant `0x2009: ' ',`**

espace chiffre

**Avant `0x200a: ' ',`**

espace fine

**Avant `0x2060: '',`**

espace ultra-fine

**Avant `0xfeff: '',`**

gluon de mots — invisible, sans largeur

**Avant `};`**

BOM en milieu de texte

**Avant `readonly replaced: readonly string[];`**

Les code points traités, en `U+XXXX`, DÉDUPLIQUÉS et triés.

⚠️ Journalisés, jamais rendus au modèle. C'est la liste qu'on relit pour savoir ce que le
modèle écrit réellement — et le seul moyen d'apprendre qu'un caractère nouveau circule
avant qu'un humain ne le voie dans un PDF.

**Avant `export function toPrintableText(raw: string, glyphs: GlyphSource): PrintableText {`**

Rend un texte imprimable par la police donnée.

⚠️ Itère sur les CODE POINTS (`for…of`), jamais sur les unités UTF-16. Un `split('')`
couperait les paires de substitution en deux moitiés invalides, et une moitié de surrogate
n'a évidemment aucun glyphe : on remplacerait un emoji par deux carrés au lieu d'un.

⚠️ Les caractères de contrôle et les blancs structurels (`\n`, `\t`) sont laissés
INTACTS sans consulter la police : ils ne sont pas rendus par un glyphe mais interprétés
par la mise en page. Les demander à la police rendrait `false` et détruirait les
paragraphes.

## `features/document/infrastructure/repositories/document.mapper.ts`

**Avant `import type { documents } from '../../../../infrastructure/database/schema';`**

Traduction entité `Document` ↔ ligne `documents`.

── Pourquoi ces mappers existent ───────────────────────────────────────────
`DrizzleDocumentRepository` se contentait de deux assertions :

    function toDomain(row)  { return row as unknown as Document; }
    function toPersistence(doc) { return doc as unknown as typeof documents.$inferInsert; }

`as unknown as` désactive TOUTE vérification : le compilateur ne peut plus
signaler qu'un champ de l'entité n'a pas de colonne. C'est précisément ce qui
est arrivé à `content`. Drizzle, de son côté, ignore silencieusement une clé
de `.values()` qui ne correspond à aucune colonne déclarée — vérifié
empiriquement : avec la colonne PRÉSENTE en base mais absente de `schema.ts`,
la ligne s'écrit avec `content` à NULL, sans le moindre avertissement.

Résultat mesuré sur la Turso de production le 2026-08-11 : 6 documents
enregistrés, 6 documents vides. `generateDocument` annonçait un succès pour
une écriture qui perdait l'essentiel.

Ces mappers énumèrent donc les champs un par un, sans assertion. Le typage
REFUSE désormais un champ non persisté : ajouter une propriété à `Document`
sans colonne correspondante casse la compilation, au lieu de disparaître.

**Avant `export function toPersistenceDocument(doc: Document): DocumentInsert {`**

Entité → ligne.

Les colonnes de STOCKAGE (`storageKey`, `fileName`, `fileSize`, `mimeType`,
`storageBucket`) restent volontairement absentes : aucun fichier n'est écrit
nulle part. Les renseigner décrirait un objet inexistant — et c'est
exactement le genre de promesse qui a produit le faux lien de téléchargement
`https://kisso.internal/docs/<uuid>/download` du 2026-08-11.

**Avant `export function toDomainDocument(row: DocumentRow): Document {`**

Ligne → entité.

`content` peut être NULL en base : les documents écrits AVANT la colonne le
sont tous. L'entité, elle, déclare `content: string` — on rend donc une
chaîne vide plutôt que de propager un `null` que le type interdit et qu'un
appelant afficherait tel quel.

## `features/document/infrastructure/repositories/in-memory-document.repository.ts`

**Avant `}`**

✅ défensive copy

✅ défensive copy

✅ stocke une copie
**Avant `this.store.delete(id);`**

✅ ajouté

**Avant `this.store.clear();`**

✅ utilitaire tests

## `features/document/infrastructure/services/docx.service.ts`

**Avant `export class DocxService implements DocumentRenderer {`**

Rend un document en DOCX (Office Open XML).

L'import est STATIQUE, contrairement au `createRequire` de `pdfmake.service.ts` :
l'analyse statique du bundler Mastra/Vercel le voit, `docx` et ses dépendances
sont donc embarqués sans passer par le rattrapage de `fix-vercel-output.js`.
C'est précisément l'invisibilité du `require()` dynamique qui avait produit le
`Cannot find module 'js-md5'` en production sur la chaîne PDF — on ne reproduit
pas ce montage ici.

⚠️ VÉRIFIÉ, mais conditionné au câblage : tant qu'aucun module atteignable
depuis `src/mastra/index.ts` n'importe ce fichier, `docx` n'entre PAS dans le
bundle (constaté sur un `npm run build` réel). Dès que le service est câblé, le
bundler embarque `docx@9.7.1` et ses cinq dépendances (`hash.js`, `jszip`,
`nanoid`, `xml`, `xml-js`), audit du bundle au vert. C'est à ce moment-là — et
pas avant, sinon le build casse — qu'il faut ajouter `docx` au garde-fou
`verify:bundle` de `package.json` (`--require pdfkit,pdfmake,js-md5,fontkit,docx`).

Aucune écriture disque : le service rend des octets, seul chemin utilisable sur
Vercel (FS en lecture seule hors `/tmp`, et éphémère).

**Avant `const filename = buildDocumentFilename(outline.title, DocumentFormat.Docx);`**

Le titre ASSAINI de l'outline, jamais `input.title` : le nom de fichier part

dans Slack et en pièce jointe email (voir `pdfmake.service.ts`).
**Avant `function renderBlock(block: DocumentBlock): Paragraph[] {`**

Traduit un bloc du modèle logique en paragraphes Word.

Un bloc `fields` devient une suite de paragraphes « **Libellé :** valeur »
plutôt qu'un tableau Word : le tableau n'apporterait rien à la lecture d'un
couple clé/valeur, et il ajouterait `Table`/`TableRow`/`TableCell` à la surface
d'API utilisée — donc autant de façons de casser au prochain bump de `docx`.

## `features/document/infrastructure/services/pdfmake.service.ts`

**Avant `type PdfMakeInstance = {`**

Types pdfmake

**Avant `let pdfmake: PdfMakeInstance | null = null;`**

Lazy loading Vercel compatible

**Avant `let fontsInitialized = false;`**

Fonts initialization

**Avant `pdfmake.setUrlAccessPolicy(() => false);`**

Sécurité :

empêche pdfmake de charger des ressources externes
**Avant `const STYLES: TDocumentDefinitions['styles'] = {`**

Traduction du modèle logique vers pdfmake

**Avant `let glyphs: GlyphSource | null = null;`**

La police, interrogée sur ce qu'elle sait écrire.

⚠️ Construite UNE FOIS et mémorisée par code point : `hasGlyphForCodePoint` parcourt les
tables de correspondance de la police, et ce rendu est appelé sur chaque feuille de chaque
bloc. Sans mémoire, un document d'une page reposerait la même question des milliers de fois.

⚠️ Elle échoue OUVERT : si la police ne peut pas être interrogée (fontkit absent du bundle,
TTF illisible), on répond « oui » à tout et l'on retombe exactement sur le comportement
d'avant ce correctif — des carrés possibles, jamais un rendu perdu. Un document livré avec
une flèche imparfaite vaut mieux qu'une génération qui échoue.

**Avant `function printable(text: string, replaced: Set<string>): string {`**

Texte prêt à imprimer, et ce qui a dû être remplacé pour cela.

Les code points traités sont ACCUMULÉS dans le tableau passé, puis journalisés une seule
fois par document : une ligne par caractère ferait du bruit sur un texte qui en contient
cinquante, et c'est le RÉPERTOIRE qui nous intéresse, pas le nombre d'occurrences.

**Avant `const replaced = new Set<string>();`**

⚠️ LE FILTRE EST POSÉ ICI, dans le renderer PDF, et NULLE PART AILLEURS.

C'est une limitation de ROBOTO, pas du produit : Word embarque des polices complètes, et

un DOCX rend parfaitement `→` et l'espace fine insécable. Poser ce filtre dans le domaine

partagé appauvrirait le DOCX pour un défaut qui ne le concerne pas — et le dépôt a déjà

écrit ce raisonnement à l'envers pour les emojis, retirés en amont parce qu'AUCUN des

deux formats ne les rendait correctement dans un document d'entreprise.
**Avant `logger.info('Caractères sans glyphe remplacés au rendu PDF', {`**

`info` et non `warn` : ce n'est pas une anomalie, c'est le filtre qui fait son travail.

Mais c'est la ligne qui dit ce que le modèle écrit RÉELLEMENT — et le seul moyen

d'apprendre qu'un caractère nouveau circule avant qu'un humain ne le voie en carré.
**Avant `defaultStyle: { font: 'Roboto' },`**

Roboto est la seule police injectée dans le VFS : tout autre nom ferait

échouer le rendu au lieu de dégrader.
**Avant `export class PdfmakeService implements DocumentRenderer {`**

Service

Rend un document en PDF.

UN SEUL chemin depuis le 2026-08-12 : `DocumentRenderer.render()`, qui rend des OCTETS et
ne touche jamais le disque.

L'ancien `PdfService.generate()` écrivait un fichier et rendait un chemin local. Il
n'existait que pour `documentGenerationWorkflow`, son unique appelant — un workflow supprimé
parce qu'il était inutilisable en production : le système de fichiers de Vercel est en
LECTURE SEULE hors `/tmp`, et `/tmp` est éphémère et propre à l'instance, donc le chemin
rendu ne désignait rien que quiconque puisse lire. Le port `PdfService` a disparu avec lui.

Ce qu'il faut retenir si l'envie revient d'écrire sur disque : sur cette plateforme, un
chemin de fichier n'est pas une livraison. La livraison, c'est l'upload Slack ou la pièce
jointe email, tous deux alimentés par les octets de `render()`.
**Avant `filename: buildDocumentFilename(outline.title, DocumentFormat.Pdf),`**

Le nom vient du titre ASSAINI de l'outline, jamais de `input.title`. La

translittération de `buildDocumentFilename` ne protège que la FORME du nom :

un titre `Guide [SECURITY_BLOCK]` en sortait `guide-security-block.pdf`, et ce

nom part dans Slack et en pièce jointe email — un canal de fuite de plus.

---
## Décisions extraites du code le 2026-08-21

> Le code ne porte plus ce texte. L'ancre est la **déclaration**, jamais un numéro
> de ligne : l'audit du 2026-08-21 a mesuré 5 424 ancres `L.N` dont 153 exactes.
> Un numéro de ligne se périme au premier retrait de commentaire.

### `src/features/document/application/tools/generate-document.ts`

**Avant `if (!canReadPersonRecord(ctx?.requestContext, employeeId)) {`**

⚠️ **LA GARDE PASSE AVANT LE CACHE D'IDEMPOTENCE — inversé le 2026-08-21.**

Le cache était consulté d'abord, et sa clé porte la CONVERSATION
(`channel` ou `channel:threadTs`). Dans un fil de canal partagé, deux personnes
partagent donc la clé : après qu'un manager avait produit un document sur X, un
non-autorisé du même fil qui reformulait à l'identique recevait le verdict en cache —
dont `recipient`, le NOM de la personne — au lieu du refus.

L'exposition était étroite (le verdict, jamais le contenu ; aucune re-livraison), mais
ce dépôt tient une règle explicite : « le refus est rendu AVANT toute lecture en base,
et les tests le vérifient en assertant que le repository n'est jamais appelé ». Le
cache n'est pas la base, mais c'est une lecture, et elle précédait la frontière. Les
deux autres outils gardés n'avaient pas cette inversion.

Aucun comportement légitime ne change : un demandeur autorisé consulte le cache
exactement comme avant, une ligne plus bas.
