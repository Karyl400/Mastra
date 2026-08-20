# Feature `directory`

> Décisions de conception, extraites des commentaires du code le 2026-08-20.
> Périmètre : `src/features/directory/`
>
> Chaque entrée porte le fichier et la ligne d'origine, ainsi que la déclaration
> qu'elle précédait. Le code ne porte plus ce texte : **c'est ici qu'il vit désormais.**

---

## `features/directory/application/services/access-guard.ts`

**L.9 — avant `export interface AccessEvaluation {`**

LE POINT D'APPLICATION de la frontière d'autorisation (P1).

`access-policy.ts` dit ce qui *devrait* se passer. Ce fichier dit ce qui se passe
*réellement* — et les deux sont délibérément séparés, parce que c'est cette séparation qui
rend le déploiement sûr.

LE MODE OBSERVATION N'EST PAS UNE PRÉCAUTION DE STYLE
`COMPETENCES_ET_ANALYSE.md` P1 chiffre le risque d'introduction ainsi : « Faible côté code.
**Réel côté exploitation** : une allowlist mal peuplée bloque les utilisateurs légitimes. »
Le remède qu'il prescrit est repris ici tel quel — journaliser ce qui SERAIT refusé, sans
rien refuser, lire les logs, puis activer.

La propriété qui compte : la décision est calculée à l'identique dans les deux modes. Le
mode observation ne court-circuite pas la politique, il court-circuite son APPLICATION.
Sans quoi les journaux qu'on relit avant d'activer décriraient un code différent de celui
qu'on activerait — et l'on n'aurait rien mesuré du tout.

⚠️ ACTIVER SANS DÉSIGNER DE MANAGER NE PEUT PAS ARRIVER
`AUTHZ_ENFORCE=true` sans qu'aucun dossier ne porte le rôle `manager` donnerait `readonly` à
TOUT LE MONDE : la politique, correctement, n'accorde `full` qu'au manager. Appliquer cela
rétrograderait l'organisation entière sur une désignation oubliée, et le symptôme (« le bot
ne sait plus rien faire ») ne désignerait pas sa cause. On refuse donc d'appliquer, on
journalise en `error`, et on reste en observation.

⚠️ Cette garde portait auparavant sur `SLACK_ORG_EMAIL_DOMAINS` vide. Elle a suivi le fait
qui décide : depuis le 2026-08-20 c'est le RÔLE, plus le domaine email. Une garde laissée sur
l'ancien fait aurait été strictement décorative — elle aurait laissé passer exactement la
panne qu'elle existe pour empêcher, en donnant l'impression contraire.
Et l'inversion est ici plus probable qu'avant : la colonne `role` naît VIDE, donc l'état
« aucun manager » est l'état de départ, pas un accident.

C'est la même doctrine que `checkTeamId` : fail-open, mais BRUYANT. Ce dépôt a déjà payé le
prix des échecs silencieux trois fois — `emailSent: false` sous `status: 'success'`,
`documents.content` perdu sans erreur, `status = Sent` posé avant l'envoi.

**L.51 — avant `readonly decision: AccessDecision;`**

 Ce que la politique décide — toujours calculé, même en observation.

**L.53 — avant `readonly effective: AccessLevel;`**

 Ce qui est réellement appliqué. En observation, toujours `full`.

**L.55 — avant `readonly enforced: boolean;`**

 `false` en observation, ou quand la configuration interdit d'appliquer.

**L.59 — avant `export type SubjectResolver = (slackUserId: string) => Promise<AccessSubject | null>;`**

 Résout le sujet d'une décision. `null` = inconnu de l'annuaire.

**L.65 — avant `readonly hasManager?: () => Promise<boolean>;`**

« Existe-t-il au moins un dossier portant le rôle `manager` ? »

OBLIGATOIRE pour que l'application ait lieu : sans ce moyen de vérifier, on ne peut pas
distinguer « la politique est configurée » de « personne n'a été désigné », et le second
cas rétrograde tout le monde. Absent ⇒ on reste en observation, bruyamment.

NE DOIT JAMAIS LEVER : une panne de lecture n'est pas une preuve d'absence. L'appelant
rend `false` en dernier recours, ce qui suspend l'application au lieu de couper l'équipe.

**L.78 — avant `const MANAGER_RECHECK_MS = 60_000;`**

Intervalle entre deux vérifications « existe-t-il un manager ? » quand la réponse est NON.

Une minute : assez court pour qu'une désignation prenne effet sans redéploiement, assez long
pour qu'un état mal configuré ne coûte pas une lecture par message.

**L.86 — avant `export function readAuthzEnforce(raw: string | undefined): boolean {`**

 Lit `AUTHZ_ENFORCE`. Tout ce qui n'est pas explicitement « vrai » vaut observation.

**L.96 — avant `private misconfigurationLogged = false;`**

 Un avertissement de configuration, pas un par message.

**L.98 — avant `private managerSeen = false;`**

Mémorisation du contrôle « existe-t-il un manager ? ».

⚠️ ASYMÉTRIQUE, et l'asymétrie est le point. Un `true` est définitif : un manager désigné
ne se dé-désigne pas en cours de vie d'instance, et re-vérifier coûterait une lecture par
message. Un `false` est RÉÉVALUÉ, avec un intervalle : sans cela, désigner un manager
n'aurait d'effet qu'au prochain démarrage à froid, et le diagnostic serait « j'ai fait ce
qu'on m'a dit et rien n'a changé » — la classe de panne la plus coûteuse de ce dépôt.

**L.116 — avant `async evaluate(slackUserId: string): Promise<AccessEvaluation> {`**

Évalue l'accès d'une personne.

NE LÈVE JAMAIS. Une panne de l'annuaire ne doit pas devenir une panne du bot : le sujet
devient `null`, donc `unknown_actor`, donc `readonly` — la réponse monotone restrictive.
C'est aussi pourquoi `unknown_actor` ne vaut pas refus : un événement parvenu jusqu'ici a
déjà franchi la signature HMAC et le contrôle de `team_id`, son origine n'est pas en
doute ; seul son privilège l'est.

**L.141 — avant `logger.info('Authorization (observation mode) — this actor WOULD be restricted', {`**

LA ligne à lire avant d'activer. Elle répond exactement à la question qu'on se pose

**L.142 — avant `logger.info('Authorization (observation mode) — this actor WOULD be restricted', {`**

à ce moment-là : « qui perdrait quoi, et pourquoi ? »

**L.165 — avant `private async canEnforce(): Promise<boolean> {`**

Applique-t-on réellement ? Non tant qu'aucun manager n'est désigné — voir l'avertissement
en tête de fichier.

**L.182 — avant `const now = Date.now();`**

Ni `Date.now()` en boucle serrée ni une lecture par message : l'intervalle borne le coût

**L.183 — avant `const now = Date.now();`**

du seul état où ce contrôle échoue, c'est-à-dire un état transitoire de configuration.

**L.188 — avant `const found = await this.hasManager().catch((error) => {`**

NE LÈVE PAS : une panne de lecture n'est pas une preuve d'absence, et refuser

**L.189 — avant `const found = await this.hasManager().catch((error) => {`**

d'appliquer est le sens le moins coûteux — c'est l'état d'avant l'activation.

**L.209 — avant `private warnOnce(message: string): void {`**

 Un avertissement de configuration pour la vie de l'instance, pas un par message.

## `features/directory/application/services/channel-coverage.service.ts`

**L.5 — avant `export interface ChannelSnapshot {`**

COUVERTURE DE CANAUX — le bot rejoint automatiquement les canaux publics.

LE DÉFAUT RÉPARÉ
Le scope `channels:join` est accordé depuis longtemps, mais **il ne fait aucun `join`
implicite** : il autorise un appel `conversations.join` que personne n'émettait. État
mesuré : le bot était membre de 2 canaux sur 5. Dans les trois autres,
`chat.postMessage` échoue en `not_in_channel` — et cet échec est INVISIBLE pour
l'utilisateur, puisque le message d'erreur de repli est posté dans le même canal
inaccessible, donc échoue à son tour. Personne ne voit rien : ni l'humain, ni le bot.

TROIS ARBITRAGES, TOUS LISIBLES DANS LE RAPPORT
 1. **Un canal privé n'est pas un échec.** `conversations.join` ne fonctionne QUE sur un
    canal public ; un privé exige une invitation humaine. On ne tente pas, on n'échoue pas,
    on NOMME l'état (`privateNotMember`) — même arbitrage que « non applicable ≠ dégradé »
    sur l'invitation Slack de l'onboarding, où compter le cas normal comme une dégradation
    aurait détruit le signal.
 2. **Idempotence.** Un canal déjà rejoint n'est pas retenté : `isMember` le dit avant tout
    appel, et Slack le redirait sans effet. Relancer ce service ne produit rien.
 3. **`missing_scope` interrompt la boucle.** C'est la seule issue qui appelle un geste
    humain (ajouter `channels:join`, **puis réinstaller l'app** — l'ajout seul ne propage
    rien). Continuer à interroger Slack N fois pour se faire refuser N fois consommerait du
    quota d'API pour ne rien apprendre de plus.

L'INVENTAIRE (2026-08-12) — OPTIONNEL, ET C'EST STRUCTUREL
Quand un `ChannelInventoryRepository` est fourni, la passe enregistre AUSSI ce qu'elle a vu :
le canal, et les membres observés de ceux où le bot peut écrire.

`inventory` est OPTIONNEL, et pas par confort : cette même fonction est câblée dans
`src/mastra/index.ts`, donc atteignable depuis le boot d'une fonction Vercel — celui qui est
SUR le chemin des 3 secondes d'ACK de Slack. Sans dépendance d'inventaire, la couverture ne
fait pas une seule écriture ni un seul appel `conversations.members` de plus qu'avant. C'est
le script de synchronisation, et lui seul, qui branche la persistance.

⚠️ Ce que l'inventaire produit est de l'OBSERVABILITÉ, jamais de l'autorisation : aucun
événement Slack ne l'invalide (`member_joined_channel` / `member_left_channel` ne sont pas
abonnés). Voir l'en-tête de `domain/entities/slack-channel.ts`.

**L.50 — avant `export interface ChannelSnapshot {`**

 Un canal, vu sous l'angle de l'accès.

**L.58 — avant `readonly memberCountReported?: number | null;`**

ASSERTION de Slack (`conversations.list` → `num_members`), quand la source la porte.

Optionnel et distinct du compte observé : ce sont deux mesures d'instants différents, et
leur écart est le seul signal de fraîcheur d'un inventaire qu'aucun événement ne dément.
`undefined` ou `null` = « Slack n'a rien affirmé », ce qu'un `0` ne dirait pas.

**L.68 — avant `export interface ChannelMemberScan {`**

 Résultat d'un balayage des membres d'un canal. `truncated` = le plafond a été touché.

**L.88 — avant `export interface ChannelAccessSource {`**

La source de canaux, déclarée par son CONSOMMATEUR.

Vocabulaire propre à la feature, et non le type de `notification/infrastructure` : la couche
`application` ne connaît pas Slack. L'adaptateur qui relie les deux vit en `infrastructure`,
seule couche où le croisement est légitime — même construction que `MemberSource`.

**L.96 — avant `listChannels(): Promise<{ channels: readonly ChannelSnapshot[]; truncated: boolean }>;`**

 Balayage complet et BORNÉ. `truncated` = le plafond de pages a été touché.

**L.100 — avant `listMembers?(channelId: string): Promise<ChannelMemberScan>;`**

Membres observés d'un canal — OPTIONNEL.

Une source qui ne sait pas énumérer les membres couvre parfaitement les canaux : l'adhésion
et l'inventaire sont deux capacités séparées, et les fondre obligerait toute doublure de
test de la couverture à simuler une API dont elle n'a que faire.

**L.125 — avant `readonly accessibleChannelIds: readonly string[];`**

LA réponse à la demande : « accès à tous les canaux dans lesquels il est invité via leur
Channel ID ». Les canaux où le bot peut écrire à l'issue de ce passage — ceux dont il était
déjà membre, et ceux qu'il vient de rejoindre. Trié, donc stable d'un appel à l'autre.

**L.133 — avant `readonly privateNotMember: readonly ChannelRef[];`**

 État NOMMÉ, jamais une erreur : il faut une invitation humaine.

**L.137 — avant `readonly missingScope: boolean;`**

 Le scope `channels:join` manque : ajouter le scope PUIS réinstaller l'app.

**L.139 — avant `readonly truncated: boolean;`**

 Le balayage a touché son plafond de pages : la liste est PARTIELLE.

**L.141 — avant `readonly inventory?: ChannelInventoryReport;`**

 Présent seulement si un `ChannelInventoryRepository` a été fourni.

**L.152 — avant `readonly channelsRecorded: number;`**

 Canaux enregistrés — TOUS ceux qui ont été vus, membres ou non.

**L.154 — avant `readonly channelsWithMembers: number;`**

 Canaux dont les membres ont été énumérés (ceux où le bot peut écrire).

**L.156 — avant `readonly membersRecorded: number;`**

 Total des appartenances observées, tous canaux confondus.

**L.158 — avant `readonly truncatedChannels: readonly string[];`**

 Canaux dont l'énumération des membres a touché le plafond : la liste est PARTIELLE.

**L.166 — avant `readonly inventory?: ChannelInventoryRepository;`**

OPTIONNEL — voir l'en-tête. Absent : aucune écriture, aucun appel supplémentaire, la
couverture se comporte exactement comme avant. C'est ce qui permet de laisser ce service
câblé au boot d'une fonction Vercel sans lui coûter une E/S.

**L.173 — avant `readonly now?: () => Date;`**

 Injectable pour les tests. Une seule horloge lue par passe : voir `run()`.

**L.195 — avant `if (channel.isArchived) {`**

ARCHIVÉ D'ABORD, avant `isMember` : `chat.postMessage` échoue en `is_archived` quel

**L.196 — avant `if (channel.isArchived) {`**

que soit `is_member`, et le bot RESTE membre des canaux archivés sous lui —

**L.197 — avant `if (channel.isArchived) {`**

`listChannelMembershipsPage` ne pose délibérément pas `exclude_archived`, ils

**L.198 — avant `if (channel.isArchived) {`**

arrivent donc bien ici. Tester l'adhésion en premier les faisait entrer dans

**L.199 — avant `if (channel.isArchived) {`**

`accessibleChannelIds`, dont le contrat est « les canaux où le bot PEUT écrire » :

**L.200 — avant `if (channel.isArchived) {`**

une promesse d'écriture certaine d'échouer, et un `archivedSkipped` qui ne les

**L.201 — avant `if (channel.isArchived) {`**

comptait jamais.

**L.208 — avant `alreadyMember += 1;`**

Un canal privé dont on EST membre est parfaitement utilisable : c'est le cas de

**L.209 — avant `alreadyMember += 1;`**

`#engineer-karyl`. « Privé » ne vaut exclusion que combiné à « pas membre ».

**L.221 — avant `failures.push({`**

Le scope manque : la tentative suivante échouerait identiquement. On enregistre

**L.222 — avant `failures.push({`**

l'échec sans consommer un appel de plus.

**L.232 — avant `const result = await deps.source.join(channel.id);`**

SÉQUENTIEL, pas `Promise.all` : `conversations.join` est plafonné par Slack, et une

**L.233 — avant `const result = await deps.source.join(channel.id);`**

salve simultanée sur un workspace fourni se ferait rate-limiter — le remède

**L.234 — avant `const result = await deps.source.join(channel.id);`**

produirait alors le symptôme qu'il vient corriger.

**L.244 — avant `alreadyMember += 1;`**

Course bénigne : quelqu'un a invité le bot entre le balayage et l'appel.

**L.250 — avant `privateNotMember.push({ id: channel.id, name: channel.name });`**

Slack contredit `is_private` (canal converti entre-temps) : état nommé, pas erreur.

**L.303 — avant `function logCoverage(report: ChannelCoverageReport): void {`**

Journalise l'issue de la passe. Extrait de `run()` : la fonction porte déjà la boucle
d'adhésion et son `switch`, et empiler trois branches de journalisation par-dessus la rendait
illisible — la lire ne doit pas coûter plus que la comprendre.

`missing_scope` d'abord : c'est la seule issue qui appelle un geste HUMAIN, et la noyer dans
le message générique de dégradation ferait manquer la seule chose à faire.

**L.340 — avant `async function recordInventory(`**

Enregistre l'inventaire — canaux vus, et membres observés de ceux où le bot peut écrire.

Rend `undefined` quand aucun repository n'est fourni, OU quand la source ne sait pas énumérer
les membres : la distinction compte, un rapport d'inventaire absent se lit « non demandé »
là qu'un rapport à zéro se lirait « demandé, rien trouvé ».

TROIS ARBITRAGES
 1. **`isMember` enregistré est celui d'APRÈS la passe d'adhésion, pas celui du balayage
    initial.** Le canal que le bot vient de rejoindre est membre ; recopier l'instantané
    d'origine écrirait `is_member = 0` sur un canal où `chat.postMessage` fonctionne
    désormais, et le seul champ dont ce booléen décide (`not_in_channel`) serait faux dès la
    première ligne.
 2. **On n'énumère les membres QUE des canaux accessibles.** `conversations.members` répond
    `channel_not_found` sur un canal privé dont le bot n'est pas membre : appeler quand même
    fabriquerait un échec par canal privé à chaque passage, c'est-à-dire un rapport
    durablement « dégradé » pour un état parfaitement normal — l'arbitrage « non applicable ≠
    dégradé », déjà tranché ici pour `privateNotMember`.
 3. **L'échec d'un canal ne coule pas la passe.** Il est nommé, compté, et les autres canaux
    continuent. Un `throw` ferait perdre l'inventaire des canaux déjà lus pour une erreur sur
    le dernier.

Une seule horloge est lue pour toute la passe : `replaceMembers` supprime les appartenances
dont le `synced_at` est ANTÉRIEUR à celui qu'on vient d'écrire. Deux horloges lues à deux
instants resteraient correctes, mais un même instant rend la passe lisible d'un seul coup
d'œil en base — tous les canaux d'un même balayage portent le même `synced_at`.

**L.419 — avant `interface ChannelRecordOutcome {`**

 Ce qu'une passe a pu faire d'UN canal. Champs absents = l'étape n'a pas eu lieu.

**L.422 — avant `readonly members?: number;`**

 Nombre de membres enregistrés. `undefined` = ils n'ont pas été énumérés.

**L.425 — avant `readonly error?: string;`**

 Message d'échec. `undefined` = aucun échec.

**L.429 — avant `async function recordOneChannel(`**

Enregistre UN canal, et ses membres s'il est accessible. Ne lève jamais : chaque échec est
rendu comme une valeur, pour que la passe continue sur les canaux suivants.

**L.448 — avant `memberCountReported: channel.memberCountReported ?? null,`**

`?? null` : une source qui ne porte pas le champ n'affirme rien. On n'invente pas un

**L.449 — avant `memberCountReported: channel.memberCountReported ?? null,`**

`0`, qui serait indiscernable d'un canal réellement vide.

**L.455 — avant `return { channelRecorded: false, error: errorMessage(error) };`**

Sans ligne de canal, l'appartenance violerait la clé étrangère : on n'essaie même pas.

**L.474 — avant `function isInventoryDegraded(inventory: ChannelInventoryReport | undefined): boolean {`**

 Un rapport d'inventaire ABSENT n'est pas dégradé : il n'a pas été demandé.

## `features/directory/application/services/directory-sync.service.ts`

**L.7 — avant `export interface EmployeeDirectoryLookup {`**

SYNCHRONISATION DE L'ANNUAIRE — Slack dit qui existe, la base s'en souvient.

CE QU'ELLE NE DOIT SURTOUT PAS FAIRE
Écraser ce que NOUS avons appris. Trois colonnes n'existent que de notre côté :

  • `dm_channel_id` — le canal `D…` d'une personne. Slack ne sait PAS nous le rendre
    (`conversations.list({ types: 'im' })` répond `missing_scope`, il faudrait `im:read`,
    qui n'est pas accordé). Il s'apprend au premier DM reçu, et une valeur perdue est perdue
    DÉFINITIVEMENT.
  • `employee_id` — le pont vers le métier.
  • `first_seen_at` — écrit une seule fois dans la vie de la ligne.

Une synchronisation complète repasse sur TOUTES les lignes. Si elle réécrivait
l'enregistrement entier, chaque passage effacerait ces trois colonnes, sans erreur ni
avertissement — le mode d'échec exact de `documents.content`, perdu sur 6 lignes sur 6.

La garantie ne vit pas ici : elle vit dans `upsertFacts`, dont le `set` énumère les champs un
à un et ne nomme jamais ces trois colonnes. Ce service **ne la contourne pas** — il n'écrit
QUE par `upsertFacts` et `linkEmployee`, jamais par un chemin qui verrait la ligne entière.

AUCUNE DÉGRADATION SILENCIEUSE
Le rapport porte un `outcome` du même vocabulaire que `OnboardingOutcome`
(`completed | degraded`) et l'inventaire de ce qui a manqué. Un compteur « 42 membres
synchronisés » sans mention des 3 qui ont échoué se lit « tout va bien » — et ce dépôt a
déjà payé trois fois ce mensonge.

**L.39 — avant `export interface EmployeeDirectoryLookup {`**

Le strict nécessaire de `EmployeeRepository` : une résolution par email.

Interface déclarée ICI, par le CONSOMMATEUR, plutôt qu'importée de `employee/domain` : deux
features ne se référencent pas au niveau applicatif, c'est la règle structurante du dépôt
(`member-source.ts` et le port `employee` dupliqué par la feature `document` font le même
choix, documenté comme intentionnel). `EmployeeRepository` la satisfait structurellement, le
câblage n'a donc rien à adapter.

**L.52 — avant `export interface DirectorySyncSource extends MemberSource {`**

La source consommée : le port `MemberSource`, plus — quand la source SAIT le dire — un aveu
de troncature.

Optionnelle parce que `MemberSource.fetchAll()` rend un tableau nu, incapable par
construction d'avouer qu'il est incomplet. Une source qui l'ignore n'est pas moins correcte ;
elle est seulement moins bavarde, et le rapport le dira (`truncated: false` est alors une
absence d'information, pas une garantie — d'où le nom de la méthode, au passé).

**L.71 — avant `readonly outcome: 'completed' | 'degraded';`**

 `degraded` dès qu'un membre a échoué, qu'un rattachement a échoué, ou que le scan est tronqué.

**L.75 — avant `readonly linked: number;`**

 Rattachements `employee_id` NOUVEAUX. Un rattachement déjà en place n'est pas recompté.

**L.78 — avant `readonly failures: readonly DirectorySyncFailure[];`**

 Borné (voir `MAX_REPORTED_FAILURES`) : le décompte, lui, ne l'est pas.

**L.81 — avant `readonly truncated: boolean;`**

 Le balayage a touché son plafond de pages : l'annuaire est PARTIEL.

**L.88 — avant `readonly employees?: EmployeeDirectoryLookup;`**

Optionnel : sans lui, aucun rattachement `employee_id` n'est tenté et le rapport le dit
(`linked: 0`). L'absence d'annuaire employé n'est pas une dégradation — c'est une
configuration, exactement comme « pas de canal de département » ne rend pas une invitation
Slack dégradée.

**L.95 — avant `readonly now?: () => Date;`**

 Injectable pour les tests ; la production passe l'heure réelle.

**L.103 — avant `const MAX_REPORTED_FAILURES = 10;`**

On ne rapporte pas 5 000 échecs.

Le cas qui produit ce volume est connu d'avance : la table `slack_directory` n'a pas été
créée (le DDL vit dans `scripts/ddl-slack-directory.sql` et s'applique à la main, les
migrations `drizzle/` étant désynchronisées). CHAQUE ligne échoue alors avec le même
`no such table`. Un échantillon nomme la cause ; le décompte, lui, reste exact.

**L.121 — avant `const knownLinks = await readKnownLinks(deps.repository);`**

Lu AVANT les upserts, en UN aller-retour : `upsertFacts` ne touche pas `employee_id`,

**L.122 — avant `const knownLinks = await readKnownLinks(deps.repository);`**

donc cette photo reste valable après. La forme « naturelle » — relire chaque ligne

**L.123 — avant `const knownLinks = await readKnownLinks(deps.repository);`**

après son upsert pour savoir si elle est rattachée — coûterait un aller-retour par

**L.124 — avant `const knownLinks = await readKnownLinks(deps.repository);`**

membre pour la même information.

**L.134 — avant `try {`**

Chaque membre est isolé : un profil malformé ne doit pas emporter l'annuaire entier.

**L.135 — avant `try {`**

Sans cette isolation, une seule ligne en échec laisserait la politique d'autorisation

**L.136 — avant `try {`**

sans aucun fait sur personne — c'est-à-dire sans aucune décision.

**L.145 — avant `continue;`**

Le rattachement suppose la ligne écrite : inutile de l'essayer.

**L.168 — avant `logger.error('Directory sync degraded', {`**

La ligne à chercher. Elle dit QUOI et POURQUOI — un booléen dirait qu'il faut

**L.169 — avant `logger.error('Directory sync degraded', {`**

réparer, jamais quoi.

**L.191 — avant `async function readKnownLinks(`**

 `slackUserId → employeeId`. Une panne de lecture n'annule pas la synchronisation.

**L.199 — avant `logger.warn('Directory sync could not read existing links — employee lookups will repeat', {`**

Conséquence assumée et NOMMÉE : sans cette photo, chaque membre porteur d'un email fera

**L.200 — avant `logger.warn('Directory sync could not read existing links — employee lookups will repeat', {`**

une résolution employé de plus. C'est du travail en trop, jamais une perte de donnée —

**L.201 — avant `logger.warn('Directory sync could not read existing links — employee lookups will repeat', {`**

`linkEmployee` est idempotent quand il repose la même valeur.

**L.209 — avant `async function linkEmployeeIfPossible(`**

Rattache `employee_id` quand l'email désigne un employé enregistré.

⚠️ ON NE DÉTACHE JAMAIS ICI, alors que le port le permet (`linkEmployee(id, null)`). Un
détachement automatique se déclencherait au premier email introuvable — profil Slack modifié,
employé en cours de migration, `users:read.email` momentanément absent — et la personne
perdrait son pont vers le métier sans que rien ne le signale. Un rattachement qui manque se
refait au passage suivant ; un rattachement effacé ne se voit pas.

**L.226 — avant `if (facts.isBot || facts.isDeleted) return 'skipped';`**

Un bot n'a pas d'employé, un compte désactivé n'a plus à en gagner un, et sans email il

**L.227 — avant `if (facts.isBot || facts.isDeleted) return 'skipped';`**

n'y a rien à résoudre. Trois filtres qui épargnent autant d'allers-retours en base.

## `features/directory/application/services/welcome-channels.service.ts`

**L.4 — avant `export type ChannelInviteStatus =`**

INVITATION D'UN ARRIVANT dans les canaux publics d'accueil.

Pourquoi un service DISTINCT de `ChannelCoverageService`
La couverture règle l'appartenance du BOT (`conversations.join`, sur lui-même) ; celui-ci
règle l'appartenance d'un TIERS (`conversations.invite`, sur quelqu'un d'autre). Ce sont
deux droits différents, deux scopes différents et deux modes d'échec différents. Les fondre
donnerait un service dont on ne saurait plus dire, en lisant un rapport dégradé, qui n'a pas
pu entrer où — et le bot est déjà membre des six canaux, donc la couverture ne rendrait
jamais rien d'utile sur ce chemin.

⚠️ `already_in_channel` est un SUCCÈS. L'objectif est « l'arrivant est dans le canal », pas
« nous l'y avons mis ». Le compter comme une erreur rendrait dégradée toute réexécution —
même arbitrage que `alreadyMember` dans la couverture, et que « non applicable ≠ dégradé »
sur l'invitation Slack du workflow d'onboarding.

⚠️ Le service est *best-effort* de bout en bout et ne lève JAMAIS : son appelant est
`handleTeamJoin`, dont le DM de bienvenue ne doit dépendre d'aucun canal. Un arrivant sans
canal mais avec son message de bienvenue peut demander de l'aide ; l'inverse ne le peut pas.

⚠️ TypeScript pur côté logique — seule la journalisation est importée.

**L.32 — avant `| 'bot_not_in_channel'`**

 Le BOT n'est pas membre : il doit rejoindre avant de pouvoir inviter quelqu'un.

**L.35 — avant `| 'missing_scope'`**

 Scope manquant — seule issue qui appelle un geste HUMAIN.

**L.49 — avant `export interface WelcomeChannelSource {`**

La source, déclarée par son CONSOMMATEUR — `application` ne connaît pas Slack.

L'adaptateur qui la relie au fournisseur Slack vit en `infrastructure`, seule couche où le
croisement entre deux features est légitime. Même construction que `MemberSource` et
`ChannelAccessSource`.

**L.57 — avant `listChannels(): Promise<readonly WelcomeChannelRef[]>;`**

 Canaux du workspace, nom ET identifiant. La résolution se fait ici, pas en config.

**L.60 — avant `join(channelId: string): Promise<ChannelInviteResult>;`**

Le bot se rend membre du canal.

Rendu sous le MÊME vocabulaire que `invite` — un seul type de résultat, donc un seul
`switch` à lire dans le service, là où deux vocabulaires proches auraient fabriqué la
confusion qu'ils prétendaient éviter.

**L.77 — avant `readonly outcome: 'completed' | 'degraded' | 'not_configured';`**

`not_configured` est DISTINCT de `completed` : « personne n'a demandé d'invitation » ne se
lit pas comme « toutes les invitations ont abouti ». Sans cette valeur, une variable
d'environnement oubliée produirait un rapport parfaitement vert.

**L.83 — avant `readonly joinedNames: readonly string[];`**

 Noms des canaux où l'arrivant se trouve à l'issue du passage — pour le DM.

**L.101 — avant `logger.warn('No welcome channels configured — skipping newcomer invitations', {`**

`warn` et non `error` : ne rien configurer est un choix légitime. Mais le silence

**L.102 — avant `logger.warn('No welcome channels configured — skipping newcomer invitations', {`**

total ferait ressembler l'absence de configuration à une panne d'invitation, et

**L.103 — avant `logger.warn('No welcome channels configured — skipping newcomer invitations', {`**

c'est précisément la ligne qu'on cherchera le jour où un arrivant n'atterrit nulle

**L.104 — avant `logger.warn('No welcome channels configured — skipping newcomer invitations', {`**

part.

**L.116 — avant `logger.error('Unable to list Slack channels for the welcome invitations', {`**

Sans annuaire de canaux, AUCUN nom n'est résoluble : on rend un échec PAR canal

**L.117 — avant `logger.error('Unable to list Slack channels for the welcome invitations', {`**

demandé plutôt qu'un rapport vide, qui se lirait « rien à faire ».

**L.145 — avant `failures.push({ name, status: 'missing_scope' });`**

La tentative suivante échouerait identiquement : on enregistre sans dépenser un

**L.146 — avant `failures.push({ name, status: 'missing_scope' });`**

appel de plus. Même arbitrage que `ChannelCoverageService`.

**L.151 — avant `const outcome = await inviteOnce(deps.source, channel, slackUserId);`**

SÉQUENTIEL, jamais `Promise.all` : `conversations.invite` est plafonné par Slack, et

**L.152 — avant `const outcome = await inviteOnce(deps.source, channel, slackUserId);`**

une salve simultanée se ferait rate-limiter — le remède produirait le symptôme.

**L.176 — avant `async function inviteOnce(`**

Une invitation, avec UN seul rattrapage : si le bot n'est pas membre du canal, il le rejoint
et réessaie.

Jamais deux fois — un `join` qui échoue est définitif pour ce passage, et boucler
consommerait du quota d'API pour répéter le même refus.

**L.193 — avant `return { status: 'bot_not_in_channel', error: joined.error };`**

On conserve le statut de l'INVITATION (`bot_not_in_channel`, la cause réelle) et

**L.194 — avant `return { status: 'bot_not_in_channel', error: joined.error };`**

l'erreur du `join` (ce qui a empêché de la lever). Écraser le premier par le second

**L.195 — avant `return { status: 'bot_not_in_channel', error: joined.error };`**

dirait « le bot n'a pas pu rejoindre » sans dire pourquoi on essayait.

**L.202 — avant `async function safely(call: () => Promise<ChannelInviteResult>): Promise<ChannelInviteResult> {`**

 Un port qui lève malgré son contrat ne doit pas couler la boucle.

**L.211 — avant `function logReport(`**

Journalise l'issue. `missing_scope` d'abord : c'est la seule issue qui appelle un geste
humain, et la noyer dans le message générique de dégradation ferait manquer la seule chose
à faire.

## `features/directory/domain/entities/directory-member.ts`

**L.1 — avant `export interface DirectoryMember {`**

Une personne du workspace Slack, telle que l'annuaire la connaît.

C'est la réponse à « qui m'écrit ? » — question que le système ne savait pas poser jusqu'ici.
`event.user` était une chaîne `U0A1N067JGL` lue pour le journal et l'anti-boucle, puis jetée :
ni la politique d'autorisation, ni les agents, ni la moindre trace d'audit ne pouvaient la
relier à un email, à un employé, ou à un statut d'invité.

⚠️ TypeScript pur — aucun import de framework. Cette entité traverse la couche `domain`.

**L.12 — avant `readonly slackUserId: string;`**

 Identifiant Slack `U…`. IMMUABLE pour la vie du compte : c'est la clé, pas l'email.

**L.16 — avant `readonly email: string | null;`**

 `null` sur les comptes sans adresse (bots) ou si `users:read.email` venait à manquer.

**L.20 — avant `readonly firstName: string | null;`**

 Voir `DirectoryMemberFacts` : lus dans le profil Slack, jamais dérivés de `realName`.

**L.23 — avant `readonly title: string | null;`**

 `profile.title` — le poste DÉCLARÉ dans Slack, distinct de `employees.position`.

**L.28 — avant `readonly isRestricted: boolean;`**

 Invité multi-canal.

**L.30 — avant `readonly isUltraRestricted: boolean;`**

 Invité mono-canal.

**L.34 — avant `readonly dmChannelId: string | null;`**

Canal `D…` du message direct, appris au premier DM reçu.

Il ne peut PAS être découvert par balayage : `conversations.list({ types: 'im' })` répond
`missing_scope` faute du scope `im:read` (vérifié le 2026-08-12). `null` signifie donc
« cette personne ne nous a jamais écrit en direct », jamais « introuvable ».

**L.43 — avant `readonly employeeId: string | null;`**

 `employees.id`, quand la personne est un employé enregistré.

**L.46 — avant `readonly isManager: boolean;`**

Cette personne porte-t-elle le rôle `manager` ?

⚠️ **Absent de `DirectoryMemberFacts`, et ce n'est pas un oubli.** Slack ne connaît pas ce
fait ; l'y faire figurer obligerait le synchroniseur à en inventer une valeur, c'est-à-dire
à fabriquer un fait d'autorisation. La séparation des deux types existe précisément pour
rendre cette erreur impossible — c'est elle qui protège déjà `dmChannelId` et `employeeId`
d'être écrasés à chaque resynchronisation.

⚠️ Il ne dépend d'AUCUN dossier employé. Le General Manager de cette entreprise n'a pas de
ligne dans `employees` : exiger un dossier aurait rendu la frontière indésignable sans en
fabriquer un, c'est-à-dire sans inventer une date d'embauche.

**L.62 — avant `readonly syncedAt: Date;`**

 Dernière confirmation par Slack de ces valeurs.

**L.66 — avant `export interface DirectoryMemberFacts {`**

Ce que Slack nous apprend d'une personne, indépendamment de ce que la base en sait déjà.

Distinct de `DirectoryMember` À DESSEIN : `dmChannelId`, `employeeId` et `firstSeenAt` sont
des faits que NOUS accumulons et que Slack ignore. Les fondre dans un seul type ferait
qu'une synchronisation, en réécrivant l'enregistrement, effacerait le canal de DM appris et
le rattachement à l'employé — une perte silencieuse, exactement le mode d'échec que ce dépôt
a déjà payé avec `documents.content`.

**L.81 — avant `readonly firstName: string | null;`**

Prénom, nom et poste — lus TELS QUELS dans `profile.first_name`, `profile.last_name` et
`profile.title`, jamais dérivés de `realName`.

C'est le point. Découper « Karyl SOUMAILA » sur l'espace marche ; découper
`ridwanenico77` — un profil réel de ce workspace, dont le nom n'est que le pseudo — donne
un prénom qui n'en est pas un et un nom vide. Une heuristique qui échoue sur un cas sur
cinq n'est pas une heuristique, c'est une invention. Slack porte ces trois champs
séparément : on les lit.

`null` signifie « Slack ne le précise pas », et c'est une réponse. Slack rend `''` pour un
champ non renseigné (le titre de Mistourath IDI, par exemple) ; on normalise en `null`
parce que `synced_at` prouve qu'on a bien interrogé — l'absence est donc AVÉRÉE, pas
inconnue.

## `features/directory/domain/entities/slack-channel.ts`

**L.1 — avant `export interface SlackChannelRecord {`**

L'INVENTAIRE DES CANAUX — ce que le bot observe des canaux où il se trouve.

════════════════════════════════════════════════════════════════════════════
⚠️ CE MODÈLE EST UN INVENTAIRE D'OBSERVABILITÉ. IL N'EST JAMAIS UNE SOURCE
   D'AUTORISATION. LE LIRE COMME UNE ACL EST UN BUG DE SÉCURITÉ.
════════════════════════════════════════════════════════════════════════════

La demande d'origine est de l'inventaire pur : « pour les canaux où le bot est invité, je veux
l'ID du canal, le nombre de personnes et les membres ». Le piège est que le résultat
RESSEMBLE à une liste d'autorisation — « les membres de #engineer-karyl » se lit sans effort
comme « qui a le droit de voir #engineer-karyl ». Or `#engineer-karyl` est PRIVÉ, et servir
son contenu à un non-membre sur la foi de ces lignes est exactement le « deputy confus » de
`PLAN-ARCHITECTURE.md` §4.1 — que la feature `knowledge` ferme, elle, en interrogeant Slack
EN DIRECT à chaque décision de divulgation.

L'aggravant est vérifié, pas supposé : **il n'existe aucun chemin d'invalidation**. Les
abonnements de l'app n'incluent ni `member_joined_channel`, ni `member_left_channel` (liste
faisant foi : `CLAUDE.md`, section « ABONNEMENTS »). Aucun événement Slack ne viendra jamais
démentir une ligne d'ici. Ces données ne sont donc pas « périmées dans trois jours » : elles
sont fausses, et silencieuses, dès la première personne qui quitte un canal entre deux
synchronisations manuelles. Une donnée fausse et muette employée comme frontière de sécurité
est pire que pas de frontière du tout — c'est la leçon d'`emailSent: false` sous
`status: 'success'`, transposée à l'autorisation.

La règle est rendue EXÉCUTABLE, et non recommandée :
`tests/unit/directory/channel-inventory-not-an-acl.test.ts` échoue si `knowledge/**`,
`access-policy.ts` ou `access-guard.ts` importent ce modèle ou son repository.

⚠️ TypeScript pur — zéro import de framework. Cette couche est verrouillée par
`tests/unit/quality/architecture.test.ts`.

**L.34 — avant `export interface SlackChannelRecord {`**

Un canal, tel que l'inventaire le connaît à sa dernière synchronisation.

`channelId` et non `name` comme identité : un canal se renomme sans que son `C…` bouge.

**L.44 — avant `readonly isMember: boolean;`**

 `true` = le bot est dedans. C'est ce que `chat.postMessage` exige, rien de plus.

**L.47 — avant `readonly memberCountReported: number | null;`**

⚠️ ASSERTION DE SLACK (`conversations.list` → `num_members`), et non un cache du nombre de
lignes de `slack_channel_members`.

Les deux chiffres viennent d'appels DISTINCTS, donc d'instants distincts, et divergent
normalement. Le vrai compte est celui des membres observés ; l'écart entre les deux est un
signal de fraîcheur gratuit. `null` = Slack n'a rien affirmé (fréquent sur les canaux
privés) — ce qu'un `0`, indiscernable d'un canal vide, ne dirait pas.

**L.61 — avant `export interface SlackChannelFacts {`**

Ce que Slack affirme d'un canal, indépendamment de ce que la base en sait déjà.

Distinct de `SlackChannelRecord` pour la même raison que `DirectoryMemberFacts` l'est de
`DirectoryMember` : `syncedAt` est un fait de NOTRE processus, pas du sien.

**L.76 — avant `export interface SlackChannelMembership {`**

Une appartenance OBSERVÉE : cette personne était dans ce canal lors de la dernière passe.

Le temps passé est la formulation exacte, et il est volontaire. Cet objet ne dit pas
« appartient », il dit « a été vu appartenant à l'instant `syncedAt` ».

**L.85 — avant `readonly firstSeenAt: Date;`**

 Première observation. SURVIT aux resynchronisations d'une personne toujours présente.

**L.87 — avant `readonly syncedAt: Date;`**

 Dernière observation. Une valeur ancienne = la personne n'a pas été revue.

**L.91 — avant `export interface SlackChannelInventoryEntry {`**

Le compte OBSERVÉ d'un canal, avec l'assertion de Slack à côté — jamais fondus.

Les fusionner en un seul nombre détruirait le seul signal de fraîcheur dont dispose une table
qu'aucun événement ne viendra jamais démentir.

**L.99 — avant `readonly observedMemberCount: number;`**

 `COUNT(*)` sur les appartenances observées. LE compte.

## `features/directory/domain/ports/channel.repository.ts`

**L.8 — avant `export interface ChannelInventoryRepository {`**

Persistance de l'INVENTAIRE des canaux et de leurs membres observés.

════════════════════════════════════════════════════════════════════════════
⚠️ AUCUNE MÉTHODE DE CE PORT NE RÉPOND À UNE QUESTION D'AUTORISATION.
════════════════════════════════════════════════════════════════════════════

Le nommage EST le garde-fou, et il est délibéré. On ne trouvera ici ni `canRead`, ni
`isAllowed`, ni `hasAccess`, ni même `isMemberOf` — pas parce que ces méthodes seraient
difficiles à écrire, mais parce qu'un nom qui pose une question d'autorisation obtient une
réponse traitée comme telle par le premier appelant venu. Les méthodes disent donc ce
qu'elles font : elles LISTENT ce qui a été OBSERVÉ, au passé, à une date que l'appelant peut
lire (`syncedAt`) et dont il doit tirer ses propres conclusions.

La raison de fond : **aucun événement ne viendra jamais invalider ces lignes**. Les
abonnements de l'app N'INCLUENT ni `member_joined_channel`, ni `member_left_channel`
(liste faisant foi : `CLAUDE.md`, section « ABONNEMENTS » — ne pas la recopier ici, la
copie qui s'y trouvait était fausse). Une décision
d'accès prise ici serait prise sur un état que rien ne dément et que personne ne rafraîchit.
La feature `knowledge` interroge Slack EN DIRECT pour cette raison exacte ; ce port ne doit
pas devenir le raccourci qui la contourne.

Verrouillé par `tests/unit/directory/channel-inventory-not-an-acl.test.ts`.

⚠️ TypeScript pur — zéro import de framework.

**L.35 — avant `upsertChannel(facts: SlackChannelFacts, now: Date): Promise<void>;`**

Enregistre ce que Slack vient d'affirmer d'un canal.

`memberCountReported` est écrit TEL QUEL, `null` compris : le repository ne le dérive
jamais du nombre de lignes de la table d'appartenances. Ce sont deux mesures d'instants
différents, et leur écart est le seul signal de fraîcheur de cet inventaire.

**L.44 — avant `replaceMembers(channelId: string, slackUserIds: readonly string[], now: Date): Promise<void>;`**

REMPLACE l'ensemble des membres observés d'un canal. Ce n'est pas une fusion.

Les membres d'un canal à l'instant T forment un ENSEMBLE, pas une accumulation : une
personne partie doit DISPARAÎTRE. Une implémentation qui se contenterait d'insérer ferait
croître la liste indéfiniment, et le `COUNT(*)` — le seul chiffre que cet inventaire existe
pour rendre — deviendrait un cumul historique.

⚠️ CONTRAT NON NÉGOCIABLE, symétrique de celui d'`upsertFacts` : `first_seen_at` SURVIT
pour une personne toujours présente. Le réécrire à chaque passage effacerait la seule
donnée que cette table accumule et que Slack ne sait pas rendre — une perte muette, dans la
lignée exacte de `documents.content`.

Un ensemble vide est une valeur LÉGITIME : elle signifie « plus personne d'observé », et
doit vider le canal.

**L.62 — avant `listChannels(): Promise<SlackChannelRecord[]>;`**

 Tout l'inventaire, trié sur `channelId` — pour les rapports et le diagnostic.

**L.65 — avant `listInventory(): Promise<SlackChannelInventoryEntry[]>;`**

Les canaux avec leur compte OBSERVÉ (`COUNT(*)`) à côté de l'assertion de Slack.

Les deux chiffres restent séparés à dessein : les fondre supprimerait l'écart, qui est
l'information.

**L.73 — avant `listObservedMembers(channelId: string): Promise<SlackChannelMembership[]>;`**

Les appartenances OBSERVÉES d'un canal, triées sur `slackUserId`.

Rend les enregistrements complets — `firstSeenAt` et `syncedAt` compris — et non de simples
identifiants : un appelant qui ne voit pas la date d'observation ne peut pas savoir qu'il
lit un état ancien. C'est le contraire d'une commodité.

**L.82 — avant `listChannelsObservedForUser(slackUserId: string): Promise<SlackChannelMembership[]>;`**

« Dans quels canaux cette personne a-t-elle été observée ? » — sert l'index sur
`slack_user_id`.

⚠️ Le nom dit « observé », au passé, et il doit le rester. `getChannelsForUser` se lirait
comme un droit d'accès ; celui-ci se lit comme ce qu'il est, une trace de balayage.

## `features/directory/domain/ports/directory.repository.ts`

**L.3 — avant `export interface DirectoryRepository {`**

Persistance de l'annuaire des personnes.

⚠️ `findBySlackUserId` est appelée sur le chemin de l'ACK Slack, celui qui n'a que 3
secondes et qui exécute déjà la prise de clé de déduplication. Une implémentation doit s'y
tenir à UN aller-retour dans le cas passant.

**L.13 — avant `findByEmail(email: string): Promise<DirectoryMember | null>;`**

 Sert la question que trois agents posaient à l'utilisateur faute de savoir y répondre.

**L.16 — avant `findByName(query: string, limit: number): Promise<DirectoryMember[]>;`**

Résout une personne par son NOM, accents et casse ignorés.

Symétrique de `EmployeeRepository.findByName`, et volontairement identique dans son
contrat : une LISTE bornée, jamais un choix arbitraire entre deux homonymes. Le
rapprochement vit dans `src/shared/name-matching.ts`, partagé par les deux — deux
implémentations divergeraient au premier accent.

⚠️ Les bots et les comptes désactivés ne sont PAS filtrés ici : c'est une décision
d'appelant, et `findByEmail` ne les filtre pas davantage. Le tool les écarte.

**L.29 — avant `upsertFacts(facts: DirectoryMemberFacts, now: Date): Promise<void>;`**

Enregistre ce que Slack vient de dire, SANS écraser ce que nous avons appris par ailleurs.

⚠️ CONTRAT NON NÉGOCIABLE : `dm_channel_id`, `employee_id` et `first_seen_at` ne figurent
pas dans `DirectoryMemberFacts` et ne doivent JAMAIS être touchés ici. Une synchronisation
complète repasse sur toutes les lignes ; si elle réécrivait l'enregistrement entier, chaque
passage effacerait le canal de DM appris au fil des messages et le rattachement à
l'employé — une perte muette, dans la lignée exacte de `documents.content`.

**L.40 — avant `rememberDmChannel(slackUserId: string, dmChannelId: string): Promise<void>;`**

Mémorise le canal de DM d'une personne, appris de son premier message direct.

Idempotent, et volontairement NON destructif : un `D…` déjà connu n'est pas remplacé.

**L.47 — avant `hasManager(): Promise<boolean>;`**

Existe-t-il au moins un dossier employé portant le rôle `manager` ?

⚠️ Une QUESTION, jamais une liste. La frontière n'a besoin que de savoir si la politique
est désignable ; rendre les identifiants exposerait qui décide, ce qui n'est utile à
personne sur ce chemin et renseignerait un attaquant sur la cible à viser.

Lecture seule. Aucun chemin de ce dépôt n'ÉCRIT le rôle : il se pose délibérément, par
`npm run role:set`. Déclarer ici une écriture en ferait une capacité du produit, donc
quelque chose qu'un futur câblage pourrait brancher sans le relire.

**L.60 — avant `findManagers(): Promise<DirectoryMember[]>;`**

Les personnes VIVANTES qui portent le rôle `manager`.

⚠️ Distinct de `hasManager()`, qui ne rend qu'un booléen. Les deux existent parce qu'ils
répondent à deux questions différentes : « la frontière est-elle applicable ? » (une
garde, appelée à chaque message) et « à qui écrire ? » (un envoi, rare). Faire porter les
deux par la même lecture ferait payer une liste à un chemin qui n'a besoin que d'un oui.

Mêmes exclusions que la politique — ni bot, ni compte désactivé : écrire à un compte que
`resolveAccess` refuse serait écrire dans le vide.

**L.73 — avant `linkEmployee(slackUserId: string, employeeId: string | null): Promise<number>;`**

 Rattache une personne à un employé enregistré. `null` détache.

**L.74 — avant `linkEmployee(slackUserId: string, employeeId: string | null): Promise<number>;`**

Rattache une ligne d'annuaire à un dossier, et rend le NOMBRE de lignes réellement
touchées.

⚠️ Le compte n'est pas un confort de journalisation — même argument que `forget(scope)`,
qui le rend pour la même raison. C'est un `UPDATE ... WHERE slack_user_id = ?` : si la
ligne n'existe pas, l'ordre réussit sans rien faire. Trouvé EN PRODUCTION le 2026-08-19,
en testant le correctif du matin même — il journalisait « Annuaire relié au dossier »
alors que zéro ligne avait bougé, ce qui est exactement la famille de défaut qu'il
fermait. Sans ce compte, l'appelant ne peut que réciter « c'est fait ».

**L.87 — avant `listAll(): Promise<DirectoryMember[]>;`**

 Tout l'annuaire, pour les usages de lecture groupée.

## `features/directory/domain/ports/member-source.ts`

**L.3 — avant `export interface MemberSource {`**

Source des faits d'annuaire — ce que le monde extérieur sait des personnes.

⚠️ CE PORT EXISTE POUR NE PAS IMPORTER `notification`. Le fournisseur réel est
`SlackWorkspaceProvider`, qui vit dans la feature `notification` : l'y référencer depuis
`directory/application` créerait une dépendance entre deux features au niveau applicatif,
dans un dépôt dont c'est justement la règle structurante. La feature `document` fait
exactement le même choix en dupliquant le port `employee` — CLAUDE.md le documente comme
intentionnel : chaque feature possède ses propres ports.

L'adaptateur qui relie les deux vit en `infrastructure`, seule couche où le croisement est
légitime.

Le port est délibérément RÉDUIT à deux méthodes — celles que l'annuaire consomme. Recopier
les sept méthodes de `SlackWorkspaceProvider` ferait entrer ici `inviteToChannel()`, une
capacité d'ÉCRITURE, dans le port d'un composant dont le rôle est de lire qui est qui.

**L.21 — avant `fetchById(slackUserId: string): Promise<DirectoryMemberFacts | null>;`**

Résout une personne par son identifiant Slack.

`null` = introuvable. Ne doit PAS lever sur une simple absence : sur le chemin de l'ACK,
une exception pour un compte inconnu coûterait le traitement du message entier.

**L.29 — avant `fetchAll(): Promise<DirectoryMemberFacts[]>;`**

 Balayage complet, pour la synchronisation périodique.

## `features/directory/domain/services/access-policy.ts`

**L.1 — avant `export type AccessLevel = 'denied' | 'readonly' | 'full';`**

LA FRONTIÈRE D'AUTORISATION (P1) — service de domaine PUR.

Constat qui a motivé ce fichier : `slack-events.handler.ts` lisait `event.user` pour le
journal et l'anti-boucle, puis le jetait. Aucune allowlist, aucun rôle, aucune vérification
d'appartenance. Tous les outils à effet de bord — `createEmployee`, `updateOnboardingStatus`,
`generateDocument`, `generateQuestionnaire`, `sendNotification`, `scheduleReminder` — étaient
donc atteignables par n'importe quel membre du workspace, invité externe compris, et par
n'importe quel texte qui traversait le routage.

POURQUOI CETTE DÉCISION EST PRISE EN CODE, ET NON PAR UN MODÈLE
`PLAN-ARCHITECTURE.md` §3.1 le formule mieux qu'on ne le referait ici : un garde-fou
déterministe échoue OUVERT MAIS SILENCIEUX (le texte passe et reste étiqueté non fiable),
là où un garde-fou LLM échoue OUVERT ET BRUYANT (le texte passe *et devient attesté
conforme*). Une décision d'autorisation prise par un modèle sur une entrée adverse n'est pas
une autorisation. D'où une fonction pure, totale, sans E/S et sans dépendance : elle se lit,
se teste exhaustivement, et ne se laisse pas convaincre.

POURQUOI LA RÈGLE EST DÉRIVÉE, ET NON ÉCRITE À LA MAIN
`COMPETENCES_ET_ANALYSE.md` P1 proposait `SLACK_ADMIN_USER_IDS=U1,U2,…`. Écarté. Ce dépôt a
déjà payé trois fois le prix d'une liste tenue à la main qui se désynchronise du réel : des
instructions d'agent nommant `discoverSlackWorkspace` et `createEmployee` longtemps après
leur retrait, la constante `WIRING` d'un test de budget, et `_measure.mts`. C'est la raison
pour laquelle `agentToolBoundary(tools)` dérive de `Object.keys(tools)` plutôt que d'une
énumération rédigée — même exigence ici.

La règle porte donc sur des faits que le SYSTÈME maintient : `is_bot`, `is_restricted`,
`is_ultra_restricted`, `deleted` — que Slack tient à jour — et le RÔLE porté par le dossier
employé. Ajouter un invité au workspace le rétrograde AUTOMATIQUEMENT, sans qu'aucune
variable d'environnement n'ait à être touchée ni qu'aucun humain n'ait à y penser.

⚠️ LE DOMAINE EMAIL N'ACCORDE PLUS RIEN — changement du 2026-08-20
`full` était accordé à toute adresse dont le domaine figurait dans
`SLACK_ORG_EMAIL_DOMAINS`. Deux défauts, et le second est le plus grave :

 1. **La portée était collective.** Les six personnes de l'organisation obtenaient la MÊME
    portée : chacune pouvait lire le dossier RH des cinq autres. « Membre de la maison » et
    « habilité à consulter le dossier de tout le monde » avaient été confondus, alors que
    ce sont deux affirmations distinctes — la première ne fonde pas la seconde.
 2. **Le fait décisif était contrôlé par le bénéficiaire.** L'adresse vient du profil Slack,
    que son porteur édite. Et, mesuré en production, elle rétrogradait l'administratrice de
    l'onboarding (adresse `gmail.com`) tout en accordant `full` à trois personnes sans
    aucun dossier employé : la frontière refusait celle qui en avait le plus besoin.

`full` ⟺ **le demandeur porte le rôle `manager`**. Tous les autres gardent leur PROPRE
dossier — `canReadPersonRecord` compare sur `employees.id` AVANT de regarder le niveau, et
`canPerformSideEffects` fait désormais de même. `readonly` ne coupe donc personne de
soi-même ; il ferme l'accès aux AUTRES.

CE QUE CE MODULE NE FAIT PAS
Il n'implémente PAS les TROIS rôles Employé / RH / Manager annoncés par `CONTEXT.md`, mais
DEUX. Inventer un palier « RH » sans tool qui en dépende produirait exactement le défaut que
ce dépôt combat — un composant enregistré qui promet plus qu'il ne tient. On ajoutera le
troisième le jour où un outil saura en faire quelque chose de différent des deux autres.

Il ne DÉCIDE pas non plus si la décision est appliquée : le mode observation vit chez
l'appelant. Cette fonction dit ce qui *devrait* se passer, toujours, même quand rien n'est
appliqué — c'est ce qui rend le mode observation mesurable.

**L.69 — avant `export type AccessLevel = 'denied' | 'readonly' | 'full';`**

Trois niveaux, ordonnés du plus restrictif au plus permissif.

 - `denied`   : l'événement n'est pas traité du tout. Aucun appel LLM, aucun tool.
 - `readonly` : traité, mais par un agent dépourvu de tout outil à effet de bord.
 - `full`     : traité par l'agent nominal.

**L.78 — avant `export type AccessReason =`**

Motif de la décision. Il est journalisé et sert le mode observation — c'est lui qui répond à
« qu'est-ce qui serait refusé si on activait ? ». Jamais montré à l'utilisateur : nommer la
règle qui a porté renseignerait un attaquant sur la sonde qui a fonctionné, exactement le
défaut corrigé sur `[SECURITY_BLOCK]`.

**L.92 — avant `export interface AccessSubject {`**

Le sujet de la décision — la personne, telle que l'annuaire la connaît.

Volontairement RÉDUIT aux champs qui portent une conséquence d'autorisation. `isAdmin` est
collecté par l'annuaire mais absent d'ici : aucun palier ne l'utilise aujourd'hui, et un
champ présent dans une signature de sécurité finit toujours par être lu comme s'il faisait
quelque chose.

**L.104 — avant `readonly isRestricted: boolean;`**

 Invité multi-canal (`is_restricted` chez Slack).

**L.106 — avant `readonly isUltraRestricted: boolean;`**

 Invité mono-canal (`is_ultra_restricted` chez Slack).

**L.109 — avant `readonly isManager: boolean;`**

Cette personne porte-t-elle le rôle `manager` ?

⚠️ Un BOOLÉEN et non la chaîne brute : ce module est pur, il n'a pas à connaître le
vocabulaire de la base. La lecture tolérante — toute valeur inconnue vaut `employee`,
jamais `manager` — vit dans `isManagerRole`, au bord où la valeur entre.

⚠️ Il ne dépend d'AUCUN dossier employé, et c'est la donnée réelle qui l'a imposé : le
General Manager de cette entreprise n'a pas de ligne dans `employees`, et 5 des 6
personnes vivantes non plus. Exiger un dossier aurait rendu la frontière indésignable
sans en fabriquer un — c'est-à-dire sans inventer une date d'embauche.

**L.124 — avant `export function resolveAccess(subject: AccessSubject | null): AccessDecision {`**

Décide du niveau d'accès. Fonction TOTALE : tout sujet, y compris `null`, reçoit une
décision — il n'existe pas d'entrée pour laquelle l'appelant aurait à inventer un défaut.

L'ORDRE DES RÈGLES EST LE FOND DU CORRECTIF, pas un détail de lecture :

  1. Les refus durs d'abord (bot, compte désactivé) — ils ne se négocient contre rien.
  2. Le statut d'invité AVANT le rôle. L'inverse accorderait `full` à un invité externe
     porteur d'un dossier marqué `manager`, c'est-à-dire précisément au cas que ce contrôle
     vise. Le rôle est un fait interne ; l'invitation est un fait de Slack, et c'est celui
     qui doit primer.
  3. Le rôle en dernier — la seule règle qui puisse ACCORDER quelque chose.

Un sujet inconnu (`null`) est rétrogradé, jamais refusé : un événement parvenu jusqu'ici a
déjà franchi la signature HMAC et le contrôle de `team_id`, son origine n'est pas en doute ;
seul son privilège l'est.

⚠️ `readonly` NE COUPE PERSONNE DE SOI-MÊME. C'est la propriété qui rend cette politique
activable : `canReadPersonRecord` et `canPerformSideEffects` comparent sur `employees.id`
AVANT de regarder le niveau. Une personne sans dossier ne perd rien non plus — elle n'a
rien à perdre. Ce que `readonly` ferme, c'est l'accès aux dossiers des AUTRES.

## `features/directory/domain/services/welcome-channel-names.ts`

**L.1 — avant `export function parseWelcomeChannelNames(raw: string | undefined | null): readonly string[] {`**

Noms de canaux d'accueil, lus d'une variable d'environnement.

Des NOMS et non des identifiants `C…` : c'est ce qu'un humain sait écrire et relire dans un
fichier de configuration, et c'est ce qu'il relira six mois plus tard sans avoir à ouvrir
Slack pour savoir de quel canal il parle. La résolution nom → identifiant est faite en
`application`, contre ce que Slack affirme au moment de l'invitation — jamais figée ici.

⚠️ TypeScript pur — aucun import.

**L.12 — avant `const seen = new Set<string>();`**

Un `Set` plutôt qu'un tableau filtré : il donne la déduplication ET conserve l'ordre

**L.13 — avant `const seen = new Set<string>();`**

d'insertion. Deux invitations dans le même canal ne casseraient rien (la seconde rendrait

**L.14 — avant `const seen = new Set<string>();`**

`already_in_channel`, comptée comme un succès), mais elles dépenseraient un appel Slack

**L.15 — avant `const seen = new Set<string>();`**

et feraient apparaître le canal deux fois dans le message de bienvenue.

**L.19 — avant `const name = part.trim().replace(/^#+/, '').trim().toLowerCase();`**

Le `#` de tête est retiré : c'est la forme sous laquelle Slack AFFICHE un canal, donc

**L.20 — avant `const name = part.trim().replace(/^#+/, '').trim().toLowerCase();`**

celle qu'un humain recopiera. L'API, elle, ne connaît que le nom nu.

## `features/directory/infrastructure/providers/slack-channel-access.adapter.ts`

**L.17 — avant `export interface SlackChannelReader {`**

Le pont entre `ChannelCoverageService` (qui ne connaît pas Slack) et `SlackWorkspaceService`
(qui ne connaît que lui). Rien d'autre : pas une décision, pas une politique.

Il vit en `infrastructure` pour la même raison que `SlackMemberSource` — c'est la seule
couche où deux features peuvent se croiser.

**L.25 — avant `export interface SlackChannelReader {`**

Le strict nécessaire côté Slack : lire une page de canaux, rejoindre un canal.

`SlackWorkspaceService` le satisfait structurellement. On ne dépend pas de
`SlackWorkspaceProvider` : ses 7 méthodes incluent `inviteToChannel`, un droit d'écriture sur
l'appartenance des AUTRES, dont la couverture de canaux n'a aucun usage.

**L.36 — avant `listChannels(): Promise<readonly { id: string; memberCount: number }[]>;`**

`conversations.list` sous sa projection RICHE — la seule qui porte `num_members`.

Elle n'est appelée que si `reportedMemberCounts` est demandé : c'est un SECOND balayage
complet du workspace, et le faire par défaut doublerait les appels de tout le monde pour un
chiffre dont seul l'inventaire a l'usage.

**L.45 — avant `getChannelMembers(channelId: string): Promise<readonly string[]>;`**

 `conversations.members`, déjà déroulé par le fournisseur.

**L.52 — avant `readonly reportedMemberCounts?: boolean;`**

Demande l'assertion `num_members` de Slack, au prix d'un second `conversations.list`.

Faux par défaut : ce composant est câblé dans `src/mastra/index.ts`, donc atteignable au
boot d'une fonction Vercel — celui qui est SUR le chemin des 3 secondes d'ACK de Slack. Le
script de synchronisation, lui, l'active.

**L.62 — avant `export const MEMBER_SCAN_CAP = SLACK_MAX_PAGES * SLACK_PAGE_LIMIT;`**

Plafond du balayage des membres d'UN canal, en identifiants.

⚠️ Pourquoi il vit ICI et pas dans la boucle de curseur : `SlackWorkspaceService.getChannelMembers`
déroule `conversations.members` avec un `while (cursor)` NU, sans plafond de pages —
contrairement à toutes les autres boucles de ce fournisseur, qui respectent `SLACK_MAX_PAGES`.
Ce fichier ne peut pas corriger la boucle (elle vit dans `notification/infrastructure`, hors
du périmètre de ce lot), mais il peut refuser de faire passer une liste sans borne pour une
liste complète.

La borne est DÉRIVÉE des deux constantes déjà en place — `SLACK_MAX_PAGES × SLACK_PAGE_LIMIT`
= 10 000 —, jamais saisie à la main : c'est exactement ce qu'aurait collecté une boucle
plafonnée. La franchir n'est donc pas une limite de capacité mais le signe d'une anomalie,
d'où la journalisation en `error` et le drapeau `truncated`. Un plafond silencieux se lit
« tout est synchronisé » — le mode d'échec que ce dépôt paie depuis `emailSent: false`.

**L.92 — avant `async listChannels(): Promise<{ channels: ChannelSnapshot[]; truncated: boolean }> {`**

Balayage PAGINÉ et BORNÉ, comme celui des membres.

`conversations.list` rend 100 entrées par défaut. Un balayage partiel ne laisserait pas le
bot dans un canal : il l'empêcherait d'y ENTRER, et le symptôme serait un `not_in_channel`
silencieux des mois plus tard, sur un canal que personne ne se souvient d'avoir créé après
la centième ligne.

Les canaux sans identifiant sont écartés : un `join('')` ne peut rien rejoindre et
fabriquerait un échec qui ne désigne rien.

**L.116 — avant `const count = reported.get(channel.id);`**

La clé n'est POSÉE que si Slack a effectivement affirmé quelque chose. Un

**L.117 — avant `const count = reported.get(channel.id);`**

`memberCountReported: null` systématique ferait dire à l'instantané « Slack affirme

**L.118 — avant `const count = reported.get(channel.id);`**

qu'il n'y a rien à affirmer », là où son ABSENCE dit ce qui est vrai : cette source

**L.119 — avant `const count = reported.get(channel.id);`**

ne porte pas l'assertion. Le consommateur retombe sur `null` par `?? null`.

**L.148 — avant `async join(channelId: string): Promise<ChannelJoinResult> {`**

 `joinChannel` ne lève jamais : chaque refus de Slack est déjà un état nommé.

**L.154 — avant `async listMembers(channelId: string): Promise<ChannelMemberScan> {`**

Membres observés d'un canal, BORNÉS.

⚠️ N'appeler que sur un canal où le bot est membre : `conversations.members` répond
`channel_not_found` sur un canal privé dont il est absent. Cette garde vit chez l'appelant
(`recordInventory`), qui est le seul à savoir ce que la passe d'adhésion vient de changer.

On ne rattrape PAS l'erreur ici : un refus de Slack sur l'énumération n'est pas un état
métier nommé comme le sont ceux de `join`. L'appelant le convertit en échec d'inventaire,
par canal, sans couler la passe.

**L.168 — avant `const memberIds = collected.filter(Boolean);`**

Les identifiants vides sont écartés : ils ne désignent personne et gonfleraient le

**L.169 — avant `const memberIds = collected.filter(Boolean);`**

`COUNT(*)`, c'est-à-dire le seul chiffre que cet inventaire existe pour rendre.

**L.184 — avant `private async readReportedMemberCounts(): Promise<Map<string, number>> {`**

L'assertion `num_members` de Slack, par identifiant de canal. Vide si non demandée.

⚠️ **Un `0` est retraduit en `null`.** `SlackWorkspaceService.listChannels()` projette
`ch.num_members ?? 0` : l'absence du champ — fréquente sur les canaux privés — y devient
indiscernable d'un canal vide. Or ce chiffre n'existe que pour être COMPARÉ au `COUNT(*)`
des membres observés, et l'écart entre les deux est le seul signal de fraîcheur d'un
inventaire qu'aucun événement Slack ne dément. Enregistrer un `0` fabriqué produirait un
écart permanent et FAUX sur chaque canal privé — un signal de fraîcheur qui crie en
permanence ne signale plus rien. `null` dit ce qui est vrai : Slack n'a rien affirmé.

Un canal réellement vide n'existe pas dans ce workspace (le bot ou le créateur y sont), donc
la retraduction ne perd aucune information réelle.

Ne lève pas : l'inventaire vaut d'être enregistré même sans l'assertion de Slack — c'est le
compte OBSERVÉ qui fait foi.

## `features/directory/infrastructure/providers/slack-member-source.adapter.ts`

**L.8 — avant `export interface SlackMemberReader {`**

L'annuaire, alimenté depuis Slack.

POURQUOI CE FICHIER VIT EN `infrastructure`
Il relie deux features : le port `MemberSource` (`directory/domain`) et
`SlackWorkspaceService` (`notification/infrastructure`). `member-source.ts` documente ce
choix — l'`infrastructure` est la seule couche où le croisement est légitime, et c'est
exactement ce que fait cet adaptateur : rien d'autre qu'une projection.

⚠️ IL NE CRÉE PAS DE SECOND `WebClient`
Il consomme le service Slack déjà câblé. Un second client dupliquerait le jeton, les
réglages de retry et les compteurs de rate-limit — deux clients ignorant chacun les appels
de l'autre franchiraient un plafond que ni l'un ni l'autre ne verrait venir.

**L.27 — avant `export interface SlackMemberReader {`**

Le strict nécessaire côté Slack — deux méthodes.

L'adaptateur ne dépend PAS de `SlackWorkspaceProvider` (7 méthodes, dont `inviteToChannel`,
une capacité d'écriture) : un annuaire dont le rôle est de lire qui est qui n'a aucune raison
de tenir un droit d'inviter. C'est aussi ce qui rend la doublure de test triviale.

**L.40 — avant `readonly maxPages?: number;`**

 Plafond de pages. Défaut : celui du service Slack. Surchargé par les tests.

**L.44 — avant `function toFacts(member: SlackMember): DirectoryMemberFacts {`**

Projection `SlackMember` → `DirectoryMemberFacts`.

Elle NE FILTRE RIEN — ni les bots, ni les comptes désactivés, ni les invités. Chacun de ces
trois états est précisément ce que la politique d'autorisation lit pour REFUSER ou
rétrograder : une source qui les écarterait produirait un annuaire où seuls figurent les
gens à qui l'on dit oui, c'est-à-dire aucune décision.

**L.59 — avant `firstName: member.firstName || null,`**

`|| null` et non `?? null` : Slack rend une CHAÎNE VIDE pour un champ de profil non

**L.60 — avant `firstName: member.firstName || null,`**

renseigné, jamais `undefined`. Avec `??` on stockerait `''`, qui se lit « renseigné,

**L.61 — avant `firstName: member.firstName || null,`**

mais vide » — indiscernable d'un vrai vide et faux positif garanti sur toute recherche.

**L.76 — avant `private truncated = false;`**

⚠️ `truncated` est un fait du DERNIER balayage, pas un état durable. Il existe parce que
`MemberSource.fetchAll()` rend un tableau nu : un tableau ne sait pas dire qu'il est
incomplet. Sans ce drapeau, une synchronisation plafonnée rapporterait « 10 000 membres
synchronisés » et serait indiscernable d'une synchronisation intégrale.

**L.91 — avant `async fetchById(slackUserId: string): Promise<DirectoryMemberFacts | null> {`**

`null` sur un compte introuvable — jamais une exception.

Cette méthode est atteignable depuis le chemin de l'ACK Slack (3 secondes) : y lever pour
un identifiant inconnu coûterait le traitement du message entier. `getUserById` traduit
déjà `user_not_found` en `null` ; ce qui reste (réseau, 5xx, rate-limit) remonte, et c'est
volontaire — une panne de Slack n'est pas une absence de personne.

**L.106 — avant `async fetchAll(): Promise<DirectoryMemberFacts[]> {`**

Balayage complet — PAGINÉ, BORNÉ, et bavard quand il est borné.

`users.list` rend **100 entrées par défaut** et n'annonce sa suite que par
`response_metadata.next_cursor`. Une lecture sans curseur — la forme « évidente » —
synchroniserait donc un annuaire partiel : la politique d'autorisation rétrograderait
ensuite en `unknown_actor` toute personne qui a eu le tort d'être en page 2. Le symptôme
(« le bot ne reconnaît que la moitié de l'équipe ») ne désignerait pas sa cause.

Les membres sans identifiant sont écartés : `slack_user_id` est la clé primaire, une chaîne
vide y créerait UN sujet fantôme que toutes les lignes suivantes viendraient écraser.

**L.163 — avant `wasLastFetchTruncated(): boolean {`**

 Le dernier `fetchAll()` a-t-il touché le plafond de pages ?

## `features/directory/infrastructure/providers/slack-welcome-channel.adapter.ts`

**L.8 — avant `export interface SlackInviteClient {`**

Le pont entre `WelcomeChannelsService` (qui ne connaît pas Slack) et `SlackWorkspaceService`
(qui ne connaît que lui). Rien d'autre : pas une décision, pas une politique.

Il vit en `infrastructure` pour la même raison que `SlackChannelAccess` et
`SlackMemberSource` — c'est la seule couche où deux features peuvent se croiser.

⚠️ Les deux méthodes Slack qu'il enveloppe ont des CONVENTIONS D'ÉCHEC OPPOSÉES, et c'est
la raison d'être de ce fichier :
  - `joinChannel` ne lève jamais : chaque refus est déjà un état nommé (`SlackJoinOutcome`) ;
  - `inviteToChannel` rend `void` et LÈVE, le code d'erreur étant enfoui dans l'exception.
Les faire remonter sous un vocabulaire unique est exactement ce que le service attend pour
n'avoir qu'un seul `switch` à lire.

**L.23 — avant `export interface SlackInviteClient {`**

Le strict nécessaire côté Slack.

On ne dépend PAS de `SlackWorkspaceProvider` entier : ses sept méthodes n'ont ici aucun
usage, et une dépendance large obligerait toute doublure de test à simuler une API dont ce
composant n'a que faire. `SlackWorkspaceService` satisfait cette interface structurellement.

**L.36 — avant `const STATUS_BY_SLACK_ERROR: ReadonlyMap<string, ChannelInviteStatus> = new Map([`**

Codes d'erreur Slack traduits en états NOMMÉS.

Liste FERMÉE : tout code absent devient `failed`, message conservé. Une traduction par défaut
optimiste ferait passer un refus inconnu pour un succès — exactement le mode d'échec de
`status = Sent` posé avant le `try`.

**L.45 — avant `['cant_invite_self', 'already_in_channel'],`**

Slack rend `cant_invite_self` quand la cible est le bot lui-même : le résultat visé

**L.46 — avant `['cant_invite_self', 'already_in_channel'],`**

(« la personne est dans le canal ») est atteint, donc ce n'est pas un échec.

**L.54 — avant `const STATUS_BY_JOIN_OUTCOME: ReadonlyMap<string, ChannelInviteStatus> = new Map([`**

`SlackJoinOutcome.status` traduit dans le vocabulaire du service.

`not_public` et `archived` deviennent `channel_not_found` : du point de vue de l'accueil,
un canal que le bot ne peut pas rejoindre et un canal qui n'existe pas produisent le même
fait — l'arrivant n'y entrera pas — et le message d'erreur conserve la cause exacte.

**L.93 — avant `return classify(error);`**

Le contrat dit « ne lève jamais » ; on ne le suppose pas pour autant. Une exception

**L.94 — avant `return classify(error);`**

qui traverserait ce point ferait échouer l'accueil entier d'un arrivant.

**L.100 — avant `function classify(error: unknown): ChannelInviteResult {`**

Le code d'erreur Slack, lu d'abord dans `error.data.error` (forme du SDK), puis dans le
message.

La seconde lecture n'est pas un luxe : `SlackWorkspaceService` réemballe certaines erreurs en
`Error` de prose, et le champ `data` disparaît alors. Sans elle, un `not_in_channel`
réemballé compterait pour un échec définitif au lieu de déclencher le rattrapage par `join`.

## `features/directory/infrastructure/repositories/drizzle-channel.repository.ts`

**L.17 — avant `const MEMBER_INSERT_CHUNK = 100;`**

Inventaire des canaux sur LibSQL/Turso.

⚠️ RAPPEL, parce que c'est le fichier qu'on ouvrira en cherchant « la liste des membres » :
ces deux tables sont un INVENTAIRE D'OBSERVABILITÉ, jamais une source d'autorisation. Aucun
événement Slack ne les invalide (`member_joined_channel` / `member_left_channel` ne sont pas
abonnés) : elles sont fausses et silencieuses dès qu'une personne quitte un canal entre deux
synchronisations. Voir l'en-tête de `domain/entities/slack-channel.ts`.

⚠️ Les tables `slack_channels` et `slack_channel_members` ne sont PAS créées par les
migrations `drizzle/` : celles-ci sont désynchronisées de `schema.ts`, et `drizzle-kit push`
se bloque indéfiniment contre une base `libsql://` distante. Le DDL
(`scripts/ddl-slack-channels.sql`) doit être appliqué à la main sur toute base neuve ou de
production, comme pour `conversation_turns`, `slack_event_dedup` et `slack_directory`.

**L.33 — avant `const MEMBER_INSERT_CHUNK = 100;`**

Taille des paquets d'insertion.

SQLite plafonne le nombre de paramètres liés d'un énoncé (999 par défaut). Une insertion
multi-lignes porte 4 colonnes par membre : au-delà de ~240 membres, un `INSERT` unique
dépasserait la borne et échouerait sur les canaux les plus peuplés — c'est-à-dire exactement
ceux pour lesquels l'inventaire a de la valeur. 100 laisse une marge confortable et garde le
nombre d'allers-retours bas.

**L.45 — avant `constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}`**

Connexion résolue PARESSEUSEMENT (fonction, pas instance) : la construire ici ouvrirait la
base au chargement du module. Le paramètre existe pour les tests, qui injectent une base
libsql en mémoire plutôt que de mocker Drizzle à la main.

**L.68 — avant `set: {`**

Champs énumérés UN À UN, comme dans `upsertFacts` de l'annuaire. `channel_id` est

**L.69 — avant `set: {`**

absent : c'est la cible du conflit. `member_count_reported` est réécrit tel quel,

**L.70 — avant `set: {`**

`null` compris — un `COALESCE` avec l'ancienne valeur conserverait une assertion

**L.71 — avant `set: {`**

périmée en la faisant passer pour actuelle.

**L.83 — avant `async replaceMembers(`**

REMPLACEMENT en deux temps, et l'ORDRE porte toute la sûreté :

  1. on marque les membres présents (`INSERT … ON CONFLICT DO UPDATE SET synced_at`) ;
  2. **ensuite seulement**, on supprime du canal ce qui porte encore un `synced_at`
     antérieur — donc ce qui n'a pas été revu.

Faire l'inverse (purger puis réinsérer) perdrait `first_seen_at` sur TOUT LE MONDE à chaque
passage, et une interruption entre les deux laisserait le canal vide. Ici, une interruption
pendant la phase 1 lève avant la suppression : rien n'est perdu, la passe suivante reprend.

`first_seen_at` n'est JAMAIS nommé dans le `set` — même contrat que `dm_channel_id` dans
`upsertFacts`, et même mode d'échec évité que `documents.content`.

`lt` et non `ne` sur la suppression : une passe concurrente plus récente aurait écrit un
`synced_at` postérieur, et l'égalité stricte inversée effacerait son travail.

**L.107 — avant `const unique = [...new Set(slackUserIds)];`**

Dédoublonnage défensif : `conversations.members` peut rendre deux fois le même

**L.108 — avant `const unique = [...new Set(slackUserIds)];`**

identifiant à cheval sur deux pages. Sans lui, l'`INSERT` multi-lignes lèverait

**L.109 — avant `const unique = [...new Set(slackUserIds)];`**

`ON CONFLICT DO UPDATE command cannot affect row a second time` — un échec de la passe

**L.110 — avant `const unique = [...new Set(slackUserIds)];`**

entière pour une redite bénigne de l'API.

**L.128 — avant `set: { syncedAt: now },`**

`first_seen_at` ABSENT du `set`, et c'est le point critique de ce fichier.

**L.140 — avant `async listChannels(): Promise<SlackChannelRecord[]> {`**

 Tri explicite : sans `ORDER BY`, deux appels identiques peuvent rendre deux ordres.

**L.147 — avant `async listInventory(): Promise<SlackChannelInventoryEntry[]> {`**

`LEFT JOIN` et non `INNER` : un canal sans aucun membre observé doit apparaître avec un
compte de 0. Un `INNER JOIN` le ferait DISPARAÎTRE du rapport, et « absent » se lirait
« pas de problème » — alors qu'un canal connu sans membre observé est précisément ce qu'il
faut voir.

**L.165 — avant `observedMemberCount: count(slackChannelMembers.slackUserId),`**

`count(colonne)` et non `count(*)` : sur un `LEFT JOIN` sans correspondance, `count(*)`

**L.166 — avant `observedMemberCount: count(slackChannelMembers.slackUserId),`**

rendrait 1 (la ligne de gauche existe), donc un canal vide serait rapporté à 1 membre.

## `features/directory/infrastructure/repositories/drizzle-directory.repository.ts`

**L.9 — avant `export class DrizzleDirectoryRepository implements DirectoryRepository {`**

Annuaire des personnes du workspace, sur LibSQL/Turso.

⚠️ La table `slack_directory` n'est PAS créée par les migrations `drizzle/` : celles-ci sont
désynchronisées de `schema.ts`, et `drizzle-kit push` se bloque indéfiniment contre une base
`libsql://` distante. Comme pour `conversation_turns` et `slack_event_dedup`, le DDL doit être
appliqué à la main sur toute base de production ou neuve.

COÛT : `findBySlackUserId` fait UN aller-retour, sur la PRIMARY KEY. C'est un plafond imposé
par le port, pas une optimisation : elle tourne sur le chemin de l'ACK Slack, celui qui n'a
que 3 secondes et qui exécute déjà la prise de clé de déduplication.

**L.22 — avant `constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}`**

La connexion est résolue PARESSEUSEMENT (fonction, pas instance) : la construire ici
ouvrirait la base au câblage de `src/mastra/index.ts`, au chargement du module. Le paramètre
existe pour les tests, qui injectent une base libsql en mémoire plutôt que de mocker
Drizzle à la main.

**L.41 — avant `async findByEmail(email: string): Promise<DirectoryMember | null> {`**

Deux passes, et l'ordre est le fond :

 1. égalité STRICTE — c'est la seule forme que `idx_slack_directory_email` sait servir. Un
    `lower(email) = ?` posé d'emblée désactiverait l'index sur toute la table ;
 2. repli insensible à la casse, seulement si la première n'a rien rendu. Slack livre des
    adresses en minuscules, donc ce chemin est celui du MISS — la comparaison faite par un
    humain qui tape « Awa.Diop@Kisso.com ». Faire payer un balayage au cas passant pour
    couvrir le cas rare serait l'arbitrage inverse.

L'index reste NON unique (voir `schema.ts`) : deux comptes peuvent porter la même adresse le
temps d'une migration. On rend la première ligne, jamais une erreur — ce port répond à
« qui est-ce ? », il n'arbitre pas les doublons.

**L.77 — avant `async upsertFacts(facts: DirectoryMemberFacts, now: Date): Promise<void> {`**

⚠️ LE POINT CRITIQUE DE CE FICHIER — le `set` de l'upsert énumère les champs UN À UN.

Ce n'est pas de la verbosité : `set: { ...values }` ou `set: member` réécrirait
l'enregistrement ENTIER, donc `dm_channel_id`, `employee_id` et `first_seen_at` avec. Une
synchronisation complète repasse sur toutes les lignes ; à chaque passage elle effacerait
le canal de DM appris au fil des messages — un canal que Slack ne sait PAS nous rendre
(`conversations.list({types:'im'})` répond `missing_scope`), donc une perte définitive — et
le rattachement à l'employé. Muette, comme `documents.content` l'a été sur 6 lignes sur 6.

`slack_user_id` est absent du `set` : c'est la cible du conflit, la réécrire n'a pas de sens.
`first_seen_at` n'est posé qu'à l'INSERT, c'est-à-dire une seule fois dans la vie de la ligne.

**L.132 — avant `async rememberDmChannel(slackUserId: string, dmChannelId: string): Promise<void> {`**

Le `IS NULL` de la clause `WHERE` porte TOUTE la garantie de non-destruction, et il la porte
atomiquement : deux DM traités en parallèle par deux instances ne peuvent pas se voler la
colonne, la seconde n'affecte aucune ligne. Un `SELECT` puis un `UPDATE` conditionnel — la
forme « naturelle » — rouvrirait cette course.

Une personne absente de l'annuaire ne provoque rien : l'`UPDATE` n'affecte aucune ligne, on
ne lève pas. La ligne est créée par `upsertFacts`, jamais ici — fabriquer un enregistrement
à partir d'un seul identifiant de canal produirait un membre sans email, sans nom et sans
flag, c'est-à-dire un sujet d'autorisation dont tous les faits seraient des valeurs par
défaut.

**L.153 — avant `async hasManager(): Promise<boolean> {`**

`LIMIT 1` et non un `COUNT(*)` : la question est « existe-t-il », pas « combien ». Compter
balaierait la table pour une réponse booléenne, et ce contrôle vit sur le chemin d'un
message.

**L.160 — avant `const row = await db`**

⚠️ Les mêmes exclusions que la politique : un bot ou un compte désactivé est REFUSÉ

**L.161 — avant `const row = await db`**

quel que soit son rôle, donc un manager désactivé n'est pas un manager. Sans ces

**L.162 — avant `const row = await db`**

clauses, la garde autoriserait l'application au nom de quelqu'un que la politique

**L.163 — avant `const row = await db`**

refuse — et rétrograderait tout le monde en croyant l'inverse.

**L.180 — avant `async findManagers(): Promise<DirectoryMember[]> {`**

 Tri sur la clé : deux appels identiques doivent rendre le même ordre.

**L.198 — avant `async linkEmployee(slackUserId: string, employeeId: string | null): Promise<number> {`**

 Destructif à dessein, contrairement à `rememberDmChannel` : `null` DÉTACHE, c'est le port.

**L.202 — avant `const result = await db`**

⚠️ On REND le compte : un `UPDATE` sans ligne correspondante réussit sans rien faire.

**L.203 — avant `const result = await db`**

Voir le port pour l'incident de production qui l'a imposé.

**L.212 — avant `async findByName(query: string, limit: number): Promise<DirectoryMember[]> {`**

Résolution par nom : UN aller-retour, puis le rapprochement en mémoire.

Voir `DrizzleEmployeeRepository.findByName` pour l'argumentaire complet — il vaut mot
pour mot ici : ni `lower()` ni `LIKE` ne savent faire ce rapprochement correctement,
et une correspondance en milieu de mot sur une résolution de personne est le défaut
qu'on corrige.

La borne est ici l'effectif du WORKSPACE Slack (40 lignes en production au
2026-08-14, bots et comptes désactivés compris), pas un volume de trafic.

**L.240 — avant `async listAll(): Promise<DirectoryMember[]> {`**

Tri explicite sur la clé : sans `ORDER BY`, deux appels identiques peuvent rendre deux ordres
différents — même défaut que celui corrigé sur `getNotificationHistory`.

## `features/directory/infrastructure/repositories/in-memory-channel.repository.ts`

**L.9 — avant `export class InMemoryChannelInventoryRepository implements ChannelInventoryRepository {`**

Doublure de test de l'inventaire des canaux.

⚠️ Elle doit reproduire EXACTEMENT deux propriétés de l'implémentation Drizzle, sans quoi elle
validerait en test un comportement que la production n'a pas :

 1. `replaceMembers` REMPLACE — une personne absente de la liste disparaît ;
 2. `first_seen_at` SURVIT pour une personne toujours présente.

Les deux implémentations sont donc exercées par la MÊME suite de tests, comme pour
`DirectoryRepository`. Une doublure plus permissive laisserait passer précisément le défaut
que ce port existe pour interdire.

⚠️ Inventaire d'observabilité — jamais une source d'autorisation. Voir
`domain/entities/slack-channel.ts`.

**L.27 — avant `private members = new Map<string, Map<string, SlackChannelMembership>>();`**

 Clé `channelId` → membres par `slackUserId`.

**L.37 — avant `memberCountReported: facts.memberCountReported,`**

Réécrit tel quel, `null` compris : conserver l'ancienne valeur ferait passer une

**L.38 — avant `memberCountReported: facts.memberCountReported,`**

assertion périmée pour actuelle.

**L.56 — avant `firstSeenAt: previous.get(slackUserId)?.firstSeenAt ?? now,`**

Le fait que NOUS accumulons — jamais réécrit par une resynchronisation.

**L.62 — avant `this.members.set(channelId, next);`**

Remplacement, pas fusion : ce qui n'est pas dans `next` a disparu.

**L.92 — avant `clear(): void {`**

 Confort de test : vide l'inventaire entre deux cas.

**L.99 — avant `function compareBinary(a: string, b: string): number {`**

Comparaison BINAIRE, celle de l'`ORDER BY` de SQLite sur une colonne `text`. `localeCompare`
s'en écarterait, et deux implémentations qui trient différemment finiraient par faire diverger
un test de la production sur un détail que personne ne relit.

## `features/directory/infrastructure/repositories/in-memory-directory.repository.ts`

**L.5 — avant `export class InMemoryDirectoryRepository implements DirectoryRepository {`**

Doublure de test du `DirectoryRepository`. Même contrat et même sémantique que
l'implémentation Drizzle — c'est elle qui sert de doublure aux tests de la politique d'accès
et des handlers, on ne mocke jamais Drizzle à la main.

⚠️ Elle doit reproduire EXACTEMENT la non-destruction de `upsertFacts` et de
`rememberDmChannel`. Une doublure plus permissive validerait en test un comportement que la
production n'a pas, et le défaut qu'elle laisserait passer — l'effacement muet du canal de DM
à chaque synchronisation — est précisément celui que ce port existe pour interdire. Les deux
implémentations sont donc exercées par la MÊME suite de tests.

**L.23 — avant `async findByEmail(email: string): Promise<DirectoryMember | null> {`**

Égalité stricte d'abord, repli insensible à la casse ensuite — dans cet ORDRE, comme côté
SQL. L'ordre est observable dès qu'une base contient deux adresses ne différant que par la
casse : l'exacte doit gagner.

**L.44 — avant `async upsertFacts(facts: DirectoryMemberFacts, now: Date): Promise<void> {`**

⚠️ LE POINT CRITIQUE — les trois champs que Slack ignore sont REPRIS de la ligne existante :
`dmChannelId`, `employeeId` et `firstSeenAt`. Écrire `{ ...facts, ...}` sans eux les
remettrait à leur valeur d'insertion à chaque synchronisation, ce que le port interdit.

**L.67 — avant `dmChannelId: previous?.dmChannelId ?? null,`**

Faits que NOUS accumulons — jamais réécrits par une synchronisation.

**L.70 — avant `isManager: previous?.isManager ?? false,`**

⚠️ CONSERVÉ, jamais réécrit par une synchronisation — même contrat que `dmChannelId`

**L.71 — avant `isManager: previous?.isManager ?? false,`**

et `employeeId` juste au-dessus. Slack ne connaît pas ce fait ; le laisser écrire par

**L.72 — avant `isManager: previous?.isManager ?? false,`**

`upsertFacts` reviendrait à fabriquer une autorisation, et une resynchronisation

**L.73 — avant `isManager: previous?.isManager ?? false,`**

rétrograderait le manager en silence.

**L.81 — avant `async rememberDmChannel(slackUserId: string, dmChannelId: string): Promise<void> {`**

 Non destructif : un `D…` déjà connu n'est pas remplacé. Personne inconnue = sans effet.

**L.89 — avant `async linkEmployee(slackUserId: string, employeeId: string | null): Promise<number> {`**

 Destructif à dessein : `null` DÉTACHE. Personne inconnue = sans effet, comme l'`UPDATE`.

**L.91 — avant `const row = this.rows.get(slackUserId);`**

⚠️ Rend 0 quand la ligne n'existe pas, comme l'`UPDATE` SQL. La doublure DOIT partager ce

**L.92 — avant `const row = this.rows.get(slackUserId);`**

contrat : c'est précisément l'écart entre « l'ordre a réussi » et « une ligne a bougé »

**L.93 — avant `const row = this.rows.get(slackUserId);`**

qui a produit un log de succès mensonger en production le 2026-08-19.

**L.100 — avant `async hasManager(): Promise<boolean> {`**

Pose le rôle — HORS DU PORT, et c'est volontaire.

`DirectoryRepository` ne déclare aucune écriture du rôle parce qu'il n'en existe aucune en
production : la colonne se pose par `npm run role:set`, délibérément, hors de portée de
tout chemin exposé à un agent. Déclarer un `setRole()` dans le port en ferait une capacité
du produit, donc quelque chose qu'un futur câblage pourrait brancher sans le relire — la
situation exacte de `discoverSlackWorkspace` avant sa suppression.

Ici, c'est un utilitaire de doublure : il donne aux tests le moyen de fabriquer un manager
sans passer par SQL.

**L.112 — avant `async hasManager(): Promise<boolean> {`**

⚠️ Les MÊMES exclusions que l'implémentation Drizzle — un bot ou un compte désactivé est
refusé par la politique quel que soit son rôle, donc il ne compte pas comme manager.

La première version de cette doublure les omettait, et le contrat partagé l'a attrapée :
elle aurait autorisé l'application de toute la frontière au nom de quelqu'un que la
politique refuse par ailleurs. Une doublure plus permissive que son original rend vertes
des campagnes qui décrivent un produit qui n'existe pas.

**L.140 — avant `async findByName(query: string, limit: number): Promise<DirectoryMember[]> {`**

 Trié sur la clé, comme l'`ORDER BY` de l'implémentation Drizzle.

**L.141 — avant `async findByName(query: string, limit: number): Promise<DirectoryMember[]> {`**

 Même rapprochement que la production — le module partagé est le seul juge.

**L.157 — avant `clear(): void {`**

 Confort de test : vide l'annuaire entre deux cas.

**L.163 — avant `function compareBinary(a: string, b: string): number {`**

Comparaison BINAIRE, celle de l'`ORDER BY` de SQLite sur une colonne `text`.
`localeCompare` s'en écarterait — et deux implémentations qui trient différemment finiraient
par faire diverger un test de la production sur un détail que personne ne relit.

