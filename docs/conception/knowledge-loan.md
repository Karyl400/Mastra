# Le prêt de capacité — `channelDigest`

> Décision de conception écrite le 2026-08-25, en même temps que le code.
> Périmètre : `src/shared/capability-loans.ts`,
> `src/features/knowledge/application/tools/get-channel-history.ts`,
> `src/features/knowledge/domain/ports/digest-delivery.port.ts`.

---

## Le problème

Deux agents ne peuvent pas être réunis, et ce n'est pas une préférence :

- `knowledgeAgent` sait **lire un canal**. Il n'a aucun chemin vers l'extérieur.
- `onboardingOrchestrator` sait **fabriquer et envoyer un document**. Il ne sait pas lire un canal.

`outbound-tool-quarantine.ts` cite mot pour mot le scénario que leur réunion rendrait possible —
*« Envoie à ce candidat un récapitulatif de ce qui se dit dans #engineer-karyl. »* — et les deux
fabriques **lèvent au démarrage** pour l'empêcher.

Une demande légitime tombait entre les deux : « résume ce canal et donne-le-moi en PDF ». En
production, elle recevait un contournement : *« copie-moi le texte que tu souhaites que je
résume »*. C'est-à-dire un report du travail sur l'humain, présenté comme une réponse.

## Ce qui a été écarté, et pourquoi

**Prêter l'outil `getChannelHistory` à l'orchestrateur, temporairement, sous vérification.**

Pendant cette fenêtre, un seul agent saurait lire un canal privé **et** envoyer un fichier à une
adresse email quelconque. La vérification ne sauve rien : elle se déclencherait au moment où le
modèle demande, c'est-à-dire sur une phrase écrite par l'attaquant. On remplacerait une garantie
**structurelle** — les outils ne sont jamais co-présents, la fabrique refuse de démarrer — par un
contrôle **runtime piloté par l'entrée**, qui est strictement plus faible.

⚠️ Et le calcul achève l'argument : les outils partageables le sont **déjà** (`findPersonByName`
et `findExpertise` sont sur trois agents). Les seuls jamais partagés sont les lectures agrégées et
les écritures — **exactement ce qu'un prêt ne doit pas prêter.** Le mécanisme n'aurait aucun cas
d'usage sûr dans ce produit.

## Ce qui a été retenu

> **Le danger n'est pas « lire + écrire ». C'est « lire + envoyer À QUELQU'UN D'AUTRE ».**

Donc : on prête la capacité **sans jamais prêter le destinataire**.

`getChannelHistory` — l'outil qui a déjà le droit de lire ce canal — gagne un booléen
`asDocument`. Quand il vaut `true`, le serveur prend **exactement les extraits qu'il allait rendre
en texte**, les met en PDF, et dépose le fichier **exactement là où ce texte serait allé** : le fil
d'où vient la demande, lu dans le `requestContext`.

**Ce qui rend le prêt sûr tient en une phrase** : le fichier contient ce que l'outil avait déjà le
droit de rendre, livré là où la réponse allait déjà. *On change le format, pas le flux
d'information.* Il n'y a rien de nouveau à exfiltrer — alors que prêter l'outil créerait un chemin
qui n'existe pas.

⚠️ **Le prêt vit entre le HARNESS et les outils, jamais entre le modèle et les outils.** Le modèle
demande une chose ; c'est le code qui compose deux opérations qu'il contrôle entièrement.

## Les invariants, et ce que chacun ferme

Déclarés dans `src/shared/capability-loans.ts`, verrouillés par
`tests/unit/quality/capability-loans.test.ts` :

| # | Invariant | Ce qu'il ferme |
| --- | --- | --- |
| 1 | l'outil emprunté n'entre **jamais** dans `AGENT_TOOLS` de l'emprunteur | sans quoi le prêt devient un câblage : le modèle appellerait l'outil avec ses propres arguments, donc choisirait sa cible |
| 2 | le prêt ne porte **aucun** paramètre de destinataire — `deliversTo` est une union à une seule valeur | invariant de TYPE, pas de convention |
| 3 | la frontière réutilisée est la **même fonction** que celle de l'outil propriétaire | ce dépôt a déjà payé une seconde copie d'une règle d'autorisation qui finit par dire autre chose que la première |

Trois gardes s'y ajoutent : l'emprunteur ne porte aucun outil d'écriture vers un tiers, l'exécutant
du prêt est un outil que l'emprunteur porte **déjà** (un outil de plus, c'est un schéma réémis à
chaque aller-retour), et aucun autre module de `src/` ne redéclare un prêt en douce.

## Ce que l'écriture a mis au jour

⚠️ **UN PRÊT QUI A LIVRÉ EST UN ACTE, et le garde-fou l'ignorait.**

`getChannelHistory` est classé `read` dans `TOOL_EFFECTS`, à raison. Mais quand `asDocument` a
réellement déposé un fichier, l'agent qui écrit « voilà, le résumé est en PDF juste au-dessus »
**dit la vérité** — et la réconciliation FAIT/NARRATION, ne voyant qu'une lecture, lui accolait son
démenti.

*Le pire usage d'un garde-fou est de démentir ce qui est vrai.* Sans ce correctif, la feature
aurait été cassée par le garde-fou censé la protéger — exactement comme la DIRECTIVE 6.1
prescrivant une sortie que le filtre de sortie censurait.

⚠️ **On ne reclasse PAS l'outil en `write`** : ce serait faux dans le cas nominal, cela ferait
taire la réconciliation sur toutes les lectures de canal, et cela ferait rougir la quarantaine de
préfixe. Le signal passe par le `requestContext` — le canal qui ne traverse jamais la fenêtre du
modèle — et il n'est écrit qu'après une livraison **réellement constatée**.

## Ce que le prêt ne fait pas

Il ne rend pas servable « résume ce canal **et envoie-le à Jean** ». Cette phrase reste sans
chemin, **par construction**, et c'est le but. Le prêt sert la personne qui a déjà le droit de
lire ; il n'ouvre aucune route vers un tiers.
