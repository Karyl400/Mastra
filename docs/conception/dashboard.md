# Feature `dashboard`

> Décisions de conception, écrites le 2026-08-25 en même temps que le code.
> Périmètre : `src/features/dashboard/`, `src/api/dashboard.route.ts`, `src/api/dashboard-page.ts`
>
> Chaque entrée est ancrée sur la **déclaration** qu'elle précède, jamais sur un numéro de
> ligne : l'audit du 2026-08-21 a mesuré 5 424 ancres `L.N` dont **153 exactes (2,8 %)**.
>
> Le code ne porte plus ce texte : **c'est ici qu'il vit.**

---

## Le problème que cette feature résout, et celui qu'elle refuse de fabriquer

Un tableau de bord se lit **passivement**. Personne ne va vérifier « satisfaction : 0 % » — on
en conclut que les gens sont mécontents, pas qu'aucune question ne leur a jamais été posée.

C'est la même famille de défaut que `emailSent: false` sous `status: 'success'`, que
`documents.content` perdu en silence, et que les cinq tâches d'onboarding qu'aucun mécanisme ne
faisait avancer : **un chiffre qui a l'air d'une mesure et qui n'en est pas une**. Le symptôme y
est simplement plus coûteux, parce que la lecture ne provoque aucune vérification.

D'où l'invariant de toute la feature : **chaque métrique déclare sa source.** Soit elle est
dérivée de tables nommées, soit elle est absente — et elle dit alors POURQUOI et CE QU'IL
FAUDRAIT pour l'obtenir. Verrouillé par `tests/unit/dashboard/metric-catalogue.test.ts`.

---

## `features/dashboard/domain/services/dashboard-snapshot.ts`

**Avant `const NO_DATA_YET: MetricReading = { available: false, gap: 'no_data_yet' };`**

⚠️ « Rien ne s'est encore produit » et « on ne sait pas mesurer ça » sont DEUX choses, et les
confondre est le défaut que tout ce module existe pour empêcher.

Un dénominateur vide n'est pas une lacune du produit : c'est une base neuve, ou une journée sans
message. La distinguer coûte une valeur d'énumération et évite au lecteur de conclure à une
panne. `no_data_yet` dit « le produit sait mesurer ceci, il n'y a rien encore » ; `not_persisted`
dit « il ne sait pas ». Les afficher pareil transformerait une base neuve en diagnostic.

**Avant `function ratio(numerator: number, denominator: number, detail?: string): MetricReading {`**

⚠️ ON NE PLAFONNE PAS UN TAUX INCOHÉRENT, ON LE NOMME.

Relevé en tirant la base locale pendant l'écriture : **93 dossiers pour 1 personne connue de
l'annuaire**, soit 9 300 %. Ramener le chiffre à 100 % le rendrait présentable et masquerait le
seul fait intéressant — que les deux tables ne parlent pas de la même population. Le détail porte
donc la mention `incohérent`, et l'interface la met en évidence.

---

## `features/dashboard/domain/services/metric-catalogue.ts`

**Avant `const CATALOGUE: readonly MetricSpec[] = [`**

CE FICHIER EST LA SOURCE UNIQUE, et l'interface en dérive entièrement.

Une métrique absente du catalogue ne peut pas être affichée ; une métrique présente sans source
ne peut pas porter de valeur. C'est ce qui rend impossible le cas qu'on veut fermer : afficher un
zéro là où il n'y a pas de mesure.

⚠️ **Un manque nommé doit pouvoir cesser d'être un manque.** Le test énumère les quatre demandes
que rien ne peut servir aujourd'hui (`satisfaction.score`, `satisfaction.sentiment`, `ai.latency`,
`health.uptime`). Si un mécanisme de feedback est livré un jour, ce test **rougira** et forcera la
mise à jour du catalogue. Sans cela, une lacune corrigée resterait affichée comme une lacune —
la même dérive, en sens inverse, que `READ_ONLY_TOOL_NAMES` gardant `getTaskList` après son
retrait.

**Sur l'entonnoir (`onboarding.funnel`)**

L'entonnoir demandé — « par étape d'onboarding » — **n'existe pas**. Tout le suivi de tâches a été
supprimé le 2026-08-14 et `onboarding_progress.total_steps` vaut 1 : le dessiner donnerait une
seule barre. Ce qu'on montre est l'entonnoir RÉEL du produit — présent dans le workspace →
rattaché à un dossier → dossier créé → parcours terminé → entretien rempli. Il révèle les mêmes
goulots, et il ne prétend pas être l'autre.

**Sur le dénominateur du taux de complétion**

Rapporté aux DOSSIERS, il vaudrait presque toujours 100 % — un dossier n'est créé qu'en complétant
le parcours. Le dénominateur honnête est le nombre de PERSONNES du workspace, c'est-à-dire le
monde réel et non la table. C'est ce rapport qui rend visible le retard de rattrapage : deux
dossiers pour six personnes réelles.

---

## `features/dashboard/infrastructure/repositories/drizzle-dashboard-facts.repository.ts`

**Avant `async function readOrMark<T>(`**

⚠️ UNE TABLE ABSENTE REND SA MÉTRIQUE INDISPONIBLE, JAMAIS LA PAGE.

Le cas est réel, rencontré en écrivant : `onboarding_interview` a été créée par un DDL appliqué
directement sur la Turso de production, donc une base locale ou neuve ne la porte pas. La première
version lançait ses onze requêtes dans un `Promise.all` nu — `no such table` tuait les onze, et le
tableau de bord entier tombait **sans désigner sa cause**.

⚠️ **La dégradation est DÉRIVÉE, pas recopiée** : chaque métrique déclare déjà les tables dont elle
sort (`source.from`), donc il n'y a aucune liste à tenir à jour en face. Ajouter une métrique sur
une nouvelle table la protège d'avance.

**Avant `const SAMPLE_CAP = 500;`**

On rend les VALEURS, pas un agrégat calculé en SQL.

La première version faisait calculer la médiane par SQLite, avec un `LIMIT 2 - count % 2 OFFSET
(count-1)/2` fragile, puis fabriquait côté TypeScript un tableau de N valeurs identiques pour que
le domaine « retrouve » cette médiane. C'était une distribution INVENTÉE pour satisfaire une
signature. Le domaine calcule désormais sur les vraies mesures, et le dépôt garde une seule
définition de la médiane.

**Avant `function fingerprint(conversationId: string): string {`**

LE FLUX NE TRANSPORTE AUCUN CONTENU DE MESSAGE.

Le manager a le droit de relire les DM depuis le 2026-08-21 — c'est une décision assumée du
propriétaire, prise en connaissance de cause. **Les faire défiler en continu sur un écran de
supervision est une autre chose, et ce n'est pas ce qui a été décidé.** Le flux porte donc
l'horodatage, le rôle, l'agent, la longueur, et une empreinte tronquée de la conversation : de
quoi voir un fil s'ouvrir et un pic arriver, jamais de quoi lire.

---

## `api/dashboard.route.ts`

**Avant `export function authorizeDashboard(`**

⚠️ FAIL-CLOSED, à l'inverse du fail-open qui gouverne le reste du dépôt.

Le fail-open est la règle ici, et à raison : `readSlackContext` rend `undefined` hors Slack, le
marqueur de progression n'est jamais un point de panne, la mémoire dégrade en silence. Dans chacun
de ces cas, l'échec retire un **confort**.

Ici, il ouvrirait une route qui rend en un GET l'avancement nominatif du personnel et le compte
des messages de chacun : **sans secret, cette page EST une fuite de données RH.** Le refus est donc
un 503 — « je refuse de servir » — et non un 401, qui suggérerait qu'un jeton existe. Même
doctrine que `CRON_SECRET`, dont l'absence rendrait la route de remise des rappels publique.

**Avant `export const dashboardPageRoute = registerApiRoute(DASHBOARD_PATH, {`**

LA PAGE NE PORTE AUCUNE DONNÉE, ET C'EST CE QUI REND LE JETON UTILISABLE.

Un jeton en query string (`?k=…`) finirait dans les journaux, l'historique du navigateur et les
en-têtes `Referer`. La coquille est donc servie sans authentification — elle ne contient aucun
chiffre — et c'est le navigateur qui demande le jeton, le garde en `sessionStorage`, et le pose en
`Authorization: Bearer` sur `/dashboard/metrics`. Un GET sur `/dashboard` ne révèle rien.

**Avant `logger.error('Lecture du tableau de bord impossible', { error });`**

Une panne de lecture ne doit pas rendre un instantané vide, qui se lirait comme « zéro partout ».
On échoue bruyamment (503) : même règle qu'`assertEmailAttachmentsFit`, qui **lève** au lieu de
rendre un booléen — un refus silencieux reproduirait le piège `emailSent: false` sous
`status: 'success'`.

**Sur le montage**

⚠️ Un fichier posé dans `src/api/` n'est **jamais** monté automatiquement — c'était la cause du bot
muet. Les deux routes sont déclarées dans `server.apiRoutes` de `src/mastra/index.ts`, et le
préfixe `/api` est réservé par `@mastra/server` (échec au DÉMARRAGE, pas 404), d'où `/dashboard`.

---

## Ce que ce tableau de bord ne mesure pas, et ce que ça dit du produit

Sur les 32 métriques du catalogue, **10 n'ont aucune source**. Ce n'est pas un défaut du tableau
de bord : c'est son principal résultat.

| Ce qui manque              | Pourquoi                                                                                                                | Ce qu'il faudrait                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| satisfaction (3 métriques) | aucune question n'est jamais posée                                                                                      | un dixième court-circuit textuel, à zéro token — les boutons ont été retirés du chemin nominal le 2026-08-19 |
| latence de l'IA            | `durationMs` est mesuré à chaque run puis **jeté**                                                                      | une ligne de plus dans l'audit existant                                                                      |
| réponses requalifiées      | la réconciliation FAIT/NARRATION produit un verdict qui part dans les logs Vercel, remis à zéro à chaque redéploiement  | un `writeAuditLog` sur le verdict                                                                            |
| canaux rejoints            | l'invitation part réellement et son issue est **jetée**                                                                 | l'écrire au moment où elle est connue                                                                        |
| document consulté          | il n'existe aucune URL de téléchargement — la livraison se fait par upload Slack                                        | servir les documents par une route du produit, ce qui rouvrirait la porte du faux lien                       |
| escalade                   | l'escalade de ce produit est une PHRASE, pas un acte                                                                    | qu'elle devienne un acte                                                                                     |
| intervention humaine       | il n'en existe aucune                                                                                                   | une reprise en main                                                                                          |
| disponibilité              | une fonction serverless ne peut pas mesurer sa propre indisponibilité — quand elle est indisponible, elle ne tourne pas | une sonde extérieure                                                                                         |

⚠️ **Quatre de ces dix lacunes ont la même cause** : la donnée existe à l'exécution et n'est écrite
nulle part. C'est la dette n° 1 de `docs/tool-design-audit.md`, vue depuis l'autre bout — et le
tableau de bord est ce qui la rend enfin visible plutôt qu'argumentée.
