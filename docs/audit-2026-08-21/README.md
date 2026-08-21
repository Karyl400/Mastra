# Audit du 2026-08-21 — rapports détaillés

Quatre sous-audits menés en parallèle et en lecture seule sur le commit `30523e0`.
La synthèse vit à la racine (`AUDIT_REPORT.md`, `AUDIT_SUMMARY.md`) — **non versionnée**,
`.gitignore` excluant `/*.md`. Ces quatre rapports-ci le sont.

| Fichier | Portée |
| --- | --- |
| `01-securite.md` | dépendances, secrets, entrées, autorisation, garde-fous LLM, RGPD, surface HTTP |
| `02-typescript.md` | `tsconfig`, typage, lint, tests, couverture, CI/CD, dépendances |
| `03-architecture.md` | règle de dépendance, cycles, SOLID, duplication, flux métier, schéma |
| `04-documentation.md` | vérité de la doc contre le code, références mortes, chiffres |

Audit précédent : `../audit-2026-08-20-100-points.html`.
