# Décisions de conception

Ce dossier porte le *pourquoi* de ce code. Il a été extrait des commentaires en deux temps :
**5 929 commentaires / 16 600 lignes** le 2026-08-20, puis les **299 commentaires /
1 656 lignes** écrits depuis, le 2026-08-21. `src/` n'en porte plus aucun — il ne reste que
**10 directives** (`eslint-disable`, `@ts-expect-error`), qui sont du comportement et non du
texte : les retirer casserait `lint` ou `tsc`.

⚠️ **L'ancre est la DÉCLARATION, jamais un numéro de ligne.** La première extraction en avait
semé 5 424 de la forme `L.189`, dont **153 exactes — 2,8 %**. Un numéro de ligne se périme au
premier retrait de commentaire, c'est-à-dire immédiatement : il ne pointait donc déjà plus
nulle part le jour où il a été écrit. Les 5 424 ont été normalisées le 2026-08-21, et
3 019 entrées qu'un même commentaire avait vu découper ligne à ligne ont été recollées.

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
