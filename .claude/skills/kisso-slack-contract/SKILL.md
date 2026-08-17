---
name: kisso-slack-contract
description: Use when touching Slack event handling, routing, subscriptions, or when a Kisso feature "doesn't fire" in production despite green tests. Checks that the declared Slack subscriptions, SUPPORTED_EVENT_TYPES, the handler's guards, and the documentation all still agree — the divergence that has already caused two wrong diagnoses.
---

# Contrat Slack — abonnements, code, documentation

## Le défaut de classe que ce skill existe pour empêcher

Un test vert ne prouve **rien** sur ce qu'un événement Slack déclenche en production : le test
fabrique l'événement, Slack décide de l'envoyer ou non. Quand les deux divergent, on obtient du
code atteignable en test et mort en production — avec une documentation qui décrit la version
testée.

C'est arrivé **deux fois, en sens inverse**, et les deux ont coûté un diagnostic :

- `message.channels` / `message.groups` étaient documentés comme abonnés et ne l'étaient **pas**.
  Tout le correctif « répondre dans un fil déjà engagé » décrivait un comportement impossible.
- `team_join` était documenté comme **non** abonné (« le trou le plus coûteux du produit ») et
  l'était. On a construit un contournement pour un trou qui n'existait pas.

## Source unique de vérité

**`CLAUDE.md`, section « ABONNEMENTS ».** Aucune autre copie de cette liste ne doit exister.

```bash
# Toute copie hors CLAUDE.md est une dette : elle divergera.
grep -rn "message\.channels\|message\.groups" --include=*.ts --include=*.md --include=*.sql \
  . | grep -v node_modules | grep -v CLAUDE.md
```

## Vérifications

### 1. Le code accepte-t-il ce que Slack envoie ?

```bash
grep -n "SUPPORTED_EVENT_TYPES" src/features/notification/infrastructure/handlers/slack-events.handler.ts
```

Tout type dans `SUPPORTED_EVENT_TYPES` mais **non abonné** = code mort en production.
Tout type abonné mais **absent** du set = événement reçu et jeté silencieusement.

### 2. Un scope manque-t-il ?

⚠️ La colonne « Required Scope » de la page *Event Subscriptions* ne liste **que** le scope de
l'événement — ce n'est **pas** la liste des scopes de l'app. Ne jamais en conclure qu'un scope
manque. Les scopes d'écriture (`chat:write`, `im:write`, `files:write`) et de lecture
(`channels:history`, `groups:history`) n'y figurent jamais et sont pourtant indispensables.

### 3. Le réglage invisible

`features.app_home.messages_tab_enabled` doit être à `true`, sinon **aucun `message.im` n'est
jamais émis**, même abonné. Il vit dans **App Home**, pas dans Event Subscriptions — la page des
abonnements paraît alors parfaite.

### 4. Ajouter un abonnement de canal : ce qu'il faut vérifier AVANT

`message.channels` livre **chaque message de chaque canal** où le bot est membre. Avant de
l'ajouter, vérifier que les deux gardes tiennent et, surtout, qu'aucun compteur n'est débité
avant elles :

- `rejectMessage` écarte un message de canal **hors fil** (`not_a_dm`) avant la limite de débit ;
- `shouldAbandonThreadReply` abandonne, en tâche de fond, tout fil où le bot n'a jamais parlé ou
  dont l'auteur ne lui a jamais parlé ;
- le budget MODÈLE ne doit être débité qu'au moment d'appeler le modèle (`chargeModelBudget`),
  jamais à l'ACK — sans quoi une conversation entre humains épuise le quota de chacun.

## Sonde de production, à coût nul

```bash
npx tsx --env-file=.env scripts/probe-deterministic-replies.mts   # ne dépense aucun token
```

## Ce qu'on ne peut pas trancher depuis le dépôt

L'état réel des abonnements et des scopes. Il se lit dans la console Slack, ou via le manifeste
(`apps.manifest.export` après `tooling.tokens.rotate` — le `xoxe-1-…` brut est un refresh token
et sera refusé). **La console peut afficher un état différent de ce qui est stocké : le
manifeste fait foi.**
