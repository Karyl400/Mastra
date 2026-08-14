# AGENT.md — Guide pour l'Agent IA

> ⚠️ **Ce fichier a été RÉÉCRIT le 2026-08-14.** Sa version précédente décrivait une structure
> `src/agents/` · `src/tools/` · `src/workflows/` qui **n'existe plus depuis la refonte
> Screaming Architecture**, ainsi qu'une stack fausse sur trois points (better-sqlite3 au lieu
> de Turso/LibSQL, « OpenAI / Gemini » au lieu de Groq → Mistral, « 4 workflows » au lieu d'un).
> Un agent qui l'aurait lu comme une carte aurait cherché des répertoires absents.

## Projet
Kisso Onboarding — plateforme d'onboarding pour Kisso Industries, sur Slack.

## Où lire quoi — dans cet ordre

| Question | Fichier |
| --- | --- |
| **Ce qui tourne réellement** | `CLAUDE.md` — et, au-dessus de lui, `npx vercel ls` |
| L'intention métier | `CONTEXT.md` |
| Les dettes ouvertes et les actions humaines | `TODO.md` |
| L'historique des décisions | `CHANGELOG.md`, `docs/adr/` |

⚠️ **`CLAUDE.md` décrit le DÉPÔT, pas la PRODUCTION**, et les deux divergent régulièrement.
Confondre les deux a déjà coûté des heures de diagnostic. Avant toute conclusion sur un
comportement observé dans Slack : `npx vercel ls` puis `git log --oneline -1`.

## Stack réelle
- Node.js `>=22.13.0` (⚠️ l'environnement tourne en v20.19.4), ESM, TypeScript strict
- Mastra `@mastra/core` 1.57.x — Agents / Tools / Workflows
- LLM : Groq `llama-3.3-70b-versatile` → repli Mistral `mistral-large-latest`
- Turso / LibSQL + Drizzle ORM · Zod **épinglé** `3.25.76` · Vitest
- Slack `@slack/web-api` · email SMTP (nodemailer) · déploiement Vercel

## Structure — par FEATURE, pas par type technique

```
src/features/<feature>/
├── domain/          # entités, value-objects, ports — TypeScript pur, ZÉRO framework
├── application/     # agents/, tools/, workflows/, dtos/, mappers/
└── infrastructure/  # repositories/, providers/, services/, handlers/
```

Features : `employee`, `onboarding`, `document`, `notification`, `conversation`, `directory`,
`knowledge`. ⚠️ `questionnaire` a été retirée du registre le 2026-08-14.

Transverse : `src/shared/`, `src/infrastructure/database/`, `src/api/`, `src/mastra/index.ts`.

**Règle de dépendance** : `domain` ne dépend de rien ; `application` dépend de `domain` ;
`infrastructure` implémente les ports. Jamais l'inverse — deux tests garde-fou la verrouillent.

## Contrainte dominante : le NOMBRE D'ÉTAPES, pas la taille du prompt

Le plafond Groq est **journalier** (100 000 tokens/jour ≈ **19 messages**), et le repli Mistral
plafonne en **requêtes** (4/min), donc insensible à tout dégraissage. Chaque étape est une
requête pleine chez les deux. Un aller-retour épargné vaut plus que plusieurs centaines de
tokens rabotés ; une réponse déterministe (zéro token) vaut plus encore.

## Règles de travail
1. Lire l'intégralité d'un fichier avant de le modifier.
2. TDD : test rouge → vert → refactor.
3. Après **chaque** modification : `npm run typecheck && npm run test:unit`.
4. Mettre à jour `TODO.md` et `CHANGELOG.md` après un changement significatif.
5. Ne pas modifier un ADR existant — en créer un nouveau.
6. Documentation en français, **code et identifiants en anglais**.

## La doctrine que ce dépôt a payée cher

**Ne jamais annoncer une action qui n'a pas eu lieu.** Quatre occurrences du même défaut y ont
coûté des données ou de la confiance : `emailSent: false` sous `status: 'success'`,
`documents.content` perdu en silence par Drizzle, `status = Sent` posé avant le `try`, et un
suivi de tâches qu'aucun mécanisme ne faisait avancer. Un échec doit être **bruyant** ; un
résultat vide doit se distinguer d'un identifiant qui ne désigne personne.

**Ce qui est dérivé du câblage ne peut pas mentir.** La frontière négative des agents vient de
`Object.keys(tools)`, et le câblage agent → outils est déclaré une seule fois
(`src/shared/agent-capabilities.ts`). Les listes écrites à la main dérivent — deux copies de ce
même câblage l'avaient fait, sans que rien ne rougisse.
