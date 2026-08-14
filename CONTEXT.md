# Contexte Projet — Kisso Onboarding

## Vision
Plateforme d'onboarding intelligent pour Kisso Industries, orchestrant l'intégration des nouveaux employés via des agents IA conversationnels. L'objectif est de faciliter l'accueil en fournissant des guidelines (LinkedIn, X, etc.), en ajoutant l'employé aux bons canaux (Slack), et en provisionnant ses comptes (Email, Github, etc.). (Voir: `docs/guides/onboarding.md`)

## Acteurs
- **Employé** : suit son onboarding, répond aux questionnaires, reçoit des notifications.
- **HR** : configure les parcours, suit les progrès, déclenche des actions.
- **Manager** : valide des étapes, reçoit des alertes.

> ⚠️ **Ce fichier décrit l'INTENTION du projet, pas son état.** Pour ce qui tourne
> réellement, la source de vérité est `CLAUDE.md` (et, au-dessus d'elle, `npx vercel ls`).
> Les sections ci-dessous ont été remises en phase avec le câblage le 2026-08-14 — elles
> annonçaient 4 workflows quand un seul est enregistré, et deux tools décâblés depuis.

## Agents IA (3)
1. **OnboardingOrchestrator** : orchestre le parcours d'intégration d'un employé.
2. **NotificationAgent** : email et Slack. Les cinq autres canaux annoncés n'ont aucun transport.
3. **KnowledgeAgent** : lecture À LA DEMANDE des conversations du bot et des canaux où il est
   invité, filtrée selon les droits du DEMANDEUR. Aucune ingestion persistante — ce serait une
   surveillance systématique des communications des salariés.

⚠️ **QuestionnaireEngine a été retiré le 2026-08-14.** Il enregistrait des quiz que personne ne
pouvait remplir (5 en base, 0 réponse). Ce qu'il devait servir — cerner les centres d'intérêt
d'un arrivant — est rendu par l'**entretien post-profil** : une modale Block Kit dont la
soumission invite réellement aux canaux choisis. Déterministe, zéro token, et il aboutit.

## Workflows (1 enregistré)
1. **EmployeeOnboarding** : déclenché par la soumission de la modale « Compléter mon profil ».
   Zéro token, déterministe, rend un verdict `completed | degraded | failed`.

⚠️ `QuestionnaireCycle`, `DocumentGeneration` et `NotificationCycle` ont été **retirés du
registre le 2026-08-12** : ils se déclaraient réussis sans faire la moindre E/S, et leur
présence à égalité avec le seul qui fonctionne le dévaluait.

## Outils réellement câblés (11)
- Personnes : `findEmployeeByEmail`, `findPersonByName` (2026-08-14).
- Dossier : `getEmployeeProfile`, `updateOnboardingStatus`.
- Production : `generateDocument`.
- Notification : `sendNotification`, `scheduleReminder`, `getNotificationHistory`.
- Lecture de conversations : `getUserConversations`, `getChannelHistory`.
- Compétences : `findExpertise` (2026-08-14) — « qui peut faire quoi », d'après le poste
  déclaré dans Slack et dans le dossier. Rend des NOMS, jamais un identifiant ni une adresse :
  la question est posée au pluriel, donc rendre des UUID inviterait le modèle à en choisir un —
  le geste exact qui a envoyé le document d'Awa à l'adresse de Karyl.

⚠️ Retirés et NON câblés : `createEmployee` (le modèle substituait une valeur d'allowlist
valide avant l'appel), `evaluateResponse` (il fabriquait les réponses d'un humain et les
enregistrait), `discoverSlackWorkspace`, **`getTaskList` avec tout le suivi de tâches** et
**`generateQuestionnaire` avec son agent** — tous deux le 2026-08-14, tous deux pour la même
raison : ils produisaient un artefact qu'aucun mécanisme ne faisait vivre. Le seul suivi est
la complétion du profil ; le seul recueil est l'entretien.

## Contraintes Techniques
- Clean Architecture (Screaming Architecture / Bounded Contexts par "Features").
- SOLID, TypeScript strict avec types purs (pas de framework dans le domaine).
- Mastra Agents/Tools/Workflows déployés sur Vercel (Serverless).
- Turso (LibSQL) + Drizzle ORM.
- Validation Zod.
- Authentification et RBAC prévus pour différencier les accès Employé, HR, Manager.

## Décisions Clés
- Questionnaires dynamiques (JSON runtime).
- Notifications multi-canal (email, Slack, in-app).
- Documentation en français, code en anglais.
- Sécurité LLM stricte avec Guardrails et validation humaine (`PENDING_APPROVAL`) pour les actions sensibles.
- Traçabilité totale via la table globale `AuditLogs`.
