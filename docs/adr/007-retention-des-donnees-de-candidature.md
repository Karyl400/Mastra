# ADR-007 : Rétention des données de candidature — expiration, pas effacement à la demande

## Statut

Accepté — 2026-08-28

## Contexte

`CLAUDE.md` a affirmé, du 2026-08-14 au 2026-08-28, à propos de la feature `recruitment` :

> **AUCUNE écriture en base, et c'est un choix.** […] stocker l'adresse et l'invitation d'un
> NON-SALARIÉ créerait des données personnelles sans chemin d'effacement — le trou déjà recensé
> pour `notifications` et `documents`. La trace vit dans le fil Slack et dans les logs.

**L'affirmation était fausse au moment où elle a été écrite.** L'audit du 2026-08-28 (§ 3.4) l'a
mesurée contre le code : `DrizzlePendingInterviewEmailRepository.save()` insère `to` — l'adresse
du **candidat** — ainsi que `candidateName`, `position` et `location` dans `pending_interview_email`.

La gravité ne tient pas à l'écriture, qui est nécessaire : le `trigger_id` d'une modale expire en
trois secondes et le bouton a été retiré le 2026-08-19, donc la préparation doit survivre entre la
demande et le « oui ». Elle tient à ce que **la phrase déclarait FERMÉ un trou qui était ouvert** —
c'est la forme de défaut que ce dépôt traque en priorité, et elle portait ici sur des données
personnelles d'une personne extérieure à l'entreprise.

Second constat, indissociable : la chaîne `forget()` — « oublie ce que je t'ai dit » — **ne touche
pas cette table**. Le droit à l'effacement que le produit accorde ne couvrait pas ces lignes.

## Ce qui rend le cas différent de tous les autres du dépôt

Partout ailleurs, le sujet de la donnée est quelqu'un qui parle au bot : il peut demander
l'effacement, et `forget()` le lui rend. **Ici le sujet est le CANDIDAT.** Il n'a aucun compte
Slack, n'a jamais écrit au bot, et ne peut donc rien demander. Un chemin d'effacement *à la
demande* est structurellement inatteignable pour lui.

⚠️ Étendre `forget()` au demandeur ne répond pas au problème : cela donnerait au **recruteur** le
droit d'effacer, ce qu'il a déjà par « non », et laisserait intacte la ligne de celui qui ne dit
plus rien — précisément le cas où la donnée dort le plus longtemps.

## Options considérées

1. **Ne rien stocker, re-rendre la préparation depuis le fil Slack.** Cohérent avec la phrase
   d'origine, et rejeté : il faudrait relire le fil pour retrouver l'adresse, ce qui est un appel
   Slack de plus sur un chemin déjà froid, et surtout cela ferait dépendre un envoi d'un texte
   relu dans un message — la primitive « envoyer un texte arbitraire à une adresse arbitraire »
   que toute la feature est construite pour ne pas offrir.
2. **Étendre `forget()` à cette table.** Rejeté ci-dessus : le sujet de la donnée n'est pas celui
   qui peut demander.
3. **Une expiration, sur la borne qui existe déjà.** Retenu.

## Décision

**La rétention est une EXPIRATION, dérivée de `PENDING_EMAIL_TTL_MS` (24 h), et elle est
inconditionnelle — sans variable d'environnement à poser.**

- `PendingInterviewEmailRepository.pruneOlderThan(cutoff)` entre au **port**, donc sur les deux
  implémentations, et son contrat est vérifié par la suite partagée
  (`tests/unit/recruitment/pending-email-repository.test.ts`) contre une **vraie base libsql** —
  « le DELETE n'a touché aucune ligne » ne se démontre pas contre une doublure.
- Le cron quotidien `/internal/reminders/dispatch` l'appelle, à côté de `pruneKnowledge`. Aucun
  appel de modèle, aucun coût par message.
- La borne est **la même constante** que `confirm-pending-email` consulte pour REFUSER d'agir sur
  une ligne expirée. Au-delà du TTL, la ligne ne peut donc plus rien produire : la conserver ne
  garde plus qu'une adresse personnelle inerte. Les deux usages bougent ensemble ou pas du tout.

⚠️ **Pas de variable d'environnement, et c'est délibéré.** `KNOWLEDGE_RETENTION_DAYS` est *opt-in
sans valeur par défaut* — et le relevé du 2026-08-22 a constaté que **l'option n'a jamais été
prise** : le cron appelait fidèlement `pruneKnowledge` chaque matin pour ressortir en
`enabled: false`, et rien n'a jamais été purgé. Reproduire cette forme ici produirait le même
résultat : une rétention qu'on croit configurée et qui n'existe pas.

⚠️ **La purge ne peut pas faire échouer la remise des rappels.** Elle est enveloppée d'un `catch`
qui journalise en `warn` et rend `null` — jamais `0`. Rendre `0` dirait « rien à purger » alors
qu'on n'a pas pu regarder, ce qui est la famille de mensonge documentée au § 9bis du même audit.
Le compte remonte dans la réponse JSON du cron, à côté de `retention`.

## Conséquences

- ✅ Une adresse de candidat vit **au plus 24 h de plus** que la fenêtre pendant laquelle elle
  pouvait servir.
- ✅ `CLAUDE.md` est corrigé : la feature écrit en base, et dit désormais ce qu'elle en fait.
- ⚠️ **Ce que cet ADR ne ferme PAS** : `notifications` et `documents` gardent le trou d'origine —
  des données personnelles de SALARIÉS sans chemin d'effacement. `forget()` les nomme
  explicitement comme non couvertes dans sa réponse à l'utilisateur, ce qui est honnête mais
  n'est pas une purge. C'est une dette distincte, et elle reste ouverte.
- ⚠️ La première exécution en production purgera d'un coup toutes les préparations abandonnées
  depuis le 2026-08-14. C'est l'effet recherché, mais il n'est pas réversible : le compte rendu
  dans la réponse du cron est la seule trace de ce qui est parti.
