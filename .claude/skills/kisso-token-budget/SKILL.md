---
name: kisso-token-budget
description: Use before adding or editing any Mastra agent instruction, tool schema, tool result, or anything that enters the model's context window in the Kisso repo. The binding constraint is a DAILY token quota (~19 messages/day), so this checks whether a change pays for itself and refuses silent budget growth.
---

# Budget de tokens — Kisso

## La contrainte, et pourquoi elle n'est pas celle qu'on croit

**Groq plafonne à ~100 000 tokens par JOUR**, soit ≈ **19 messages par jour, tous canaux
confondus** (à 5 168 tokens/message mesurés). Le repli Mistral plafonne en **REQUÊTES**
(4/minute) — donc **insensible à tout dégraissage de prompt**.

⚠️ Une panne de quota a déjà été diagnostiquée comme un bug logiciel, ce qui a coûté des heures.
Vérifier les en-têtes **avant** de conclure. Et vérifier que le modèle primaire existe encore :
`llama-3.3-70b-versatile` a été retiré du compte Groq sans préavis le 2026-08-15.

```bash
curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
```

## LA règle de doctrine

> **Le poste de coût dominant n'est pas la TAILLE du prompt, c'est le NOMBRE D'ÉTAPES.**

Chaque étape est une requête pleine chez les deux fournisseurs. **Un aller-retour épargné vaut
plus que plusieurs centaines de tokens rabotés** — et un tour de dialogue épargné (un champ à
défaut plutôt qu'une question posée à l'humain) vaut plus encore.

Corollaire contre-intuitif : ajouter 117 tokens à un agent pour lui éviter une question à
l'humain est un **gain**, pas une dépense.

## Avant d'ajouter quoi que ce soit

1. **Est-ce que ça supprime une ÉTAPE ?** Si oui, l'ajout est probablement rentable même s'il
   coûte des tokens. Le dire explicitement.
2. **Est-ce autofinancé ?** Mesurer le FLOOR avant/après. Si non, **le dire** — plusieurs lots
   de ce dépôt ne l'étaient pas et ont été acceptés en connaissance de cause. Le mensonge par
   omission est le problème, pas la dépense.
3. **Est-ce que ça peut être du CODE plutôt qu'un token ?** Un court-circuit déterministe coûte
   **zéro**. Huit d'entre eux répondent déjà sans aucun appel de modèle.

## Le poste le plus cher, et le plus souvent oublié

**Un tool-result n'est pas payé une fois** : il entre dans l'historique et est **réémis à chaque
aller-retour suivant**. Trois occurrences du même défaut, toutes corrigées :

| Tool | Avant | Après |
| --- | --- | --- |
| `getEmployeeProfile` | 2 506 | 333 |
| `getNotificationHistory` | ≈ 9 600 | 177 |
| `generateDocument` | 685 | 39 |

⚠️ **La propriété qui compte n'est pas le chiffre, c'est l'INDÉPENDANCE** : la taille du résultat
ne doit dépendre ni du nombre de lignes, ni de la longueur du contenu. C'est ce que verrouillent
`tests/unit/tools/tool-result-budget.test.ts` et `agent-instructions-budget.test.ts`.

Ne JAMAIS renvoyer au modèle un texte qu'il vient d'écrire (`subject`, `body`, `content`).

## Mesurer

```bash
npm run test:unit -- tool-result-budget agent-instructions-budget
```

Ratio de conversion du dépôt : **3,5 caractères par token**.

⚠️ `usage.inputTokens` **cumule toutes les étapes** : comparer deux mesures sans vérifier
`steps.length` mène à des conclusions fausses.

## Le correctif qui bat tous les autres

Passer Groq en palier payant. Meilleur rapport effort/effet du dossier, et **pas une ligne de
code**. Sans ce geste, la prochaine campagne s'arrête au ~19ᵉ message quels que soient les
correctifs logiciels.
