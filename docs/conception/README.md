# Décisions de conception

Ce dossier porte le *pourquoi* de ce code. Il a été extrait des commentaires le 2026-08-20 :
**5 929 commentaires, 16 600 lignes**, retirés de `src/` et redistribués ici, une page par
feature. Le code n'en porte plus aucun, à l'exception des directives fonctionnelles
(`eslint-disable`, `@ts-*`), qui sont du comportement et non du texte.

Chaque entrée indique le fichier, la ligne d'origine et la déclaration qu'elle précédait.

| Document | Périmètre |
| --- | --- |
| [`conversation.md`](conversation.md) | Mémoire conversationnelle, fenêtrage en tokens, TTL |
| [`directory.md`](directory.md) | Annuaire Slack, frontière d'autorisation |
| [`document.md`](document.md) | Rendu PDF et DOCX, livraison, assainissement du contenu |
| [`employee.md`](employee.md) | Dossiers employés, résolution par nom et par email |
| [`knowledge.md`](knowledge.md) | Lecture de canaux, saillance des extraits, quarantaine |
| [`notification.md`](notification.md) | Routage Slack, limitation de débit, court-circuits, transports |
| [`onboarding.md`](onboarding.md) | Parcours d'accueil, entretien, email de bienvenue |
| [`recruitment.md`](recruitment.md) | Préparation d'un email d'entretien candidat |
| [`shared.md`](shared.md) | Garde-fous de sécurité, chaîne de modèles, logger, contexte |
| [`plateforme.md`](plateforme.md) | Routes HTTP, câblage Mastra, base de données |

## Comment lire ces pages

Elles ne décrivent pas ce que fait le code — le code le dit. Elles disent **pourquoi il le
fait ainsi**, et presque toujours en citant l'incident qui l'a imposé : un bot muet pendant
des heures, un document livré sans trace, un statut posé avant l'acte qu'il décrit.

## Un avertissement, tiré de l'audit du 2026-08-20

Sur les onze affirmations fausses trouvées dans ce dépôt, **onze étaient dans la
documentation à distance** et aucune dans les commentaires adjacents au code. Un texte cesse
d'être relu dès qu'il cesse d'être sous les yeux de celui qui modifie.

Ces pages sont donc exposées à cette dérive plus que ne l'était le code. La contrepartie
demandée : **quand une décision change, cette page change dans le même commit.** Une entrée
qui décrit un état révolu est pire qu'une entrée absente — elle se fait croire.
