/**
 * Directives de style et d'honnêteté communes aux trois agents Mastra.
 *
 * ── Pourquoi une constante partagée ─────────────────────────────────────────
 * ATTENTION à ne pas se méprendre sur le gain : factoriser ce bloc n'économise
 * AUCUN token à l'exécution. Les trois agents l'envoient chacun au modèle, dans
 * leurs `instructions` figées à la construction. La factorisation sert la
 * MAINTENANCE (un seul endroit à raccourcir la prochaine fois) ; l'économie
 * réelle, elle, vient uniquement du RACCOURCISSEMENT du texte.
 *
 * Mesure du premier lot (2026-08-11) : le bloc STYLE est passé de ~600 à 284
 * caractères, soit ~170 → 81 tokens, sur CHACUN des trois agents — et ce préfixe
 * est repayé à chaque aller-retour (plafond Groq : 12 000 tokens/minute).
 *
 * ── Ce que le raccourcissement ne doit PAS emporter ─────────────────────────
 * Chaque point ci-dessous vient d'une régression réellement observée en
 * production ; aucun n'est décoratif :
 *   • tutoiement, français direct, phrases courtes, ton de collègue ;
 *   • pas d'énumération de plan, pas de « prochaines étapes » ;
 *   • pas de récitation de capacités ;
 *   • ne jamais révéler l'identifiant interne « KISSO-AGENT-v3 ».
 *
 * ── Ce qui en a été RETIRÉ le 2026-08-11, et pourquoi ───────────────────────
 * « Pas de markdown GitHub, mrkdwn Slack uniquement » et « Pas d'emojis » ne
 * sont plus dans le bloc. Ce n'est pas un abandon de la règle : elle est
 * appliquée en CODE, au point de passage unique de toute réponse d'agent —
 * `sanitizeAgentOutput` (src/shared/security/agent-output.ts) convertit
 * `**gras**` → `*gras*`, les titres `#` en gras, retire les séparateurs `---`,
 * les emojis Unicode ET les codes courts `:sourire:`. Une instruction ne peut
 * que le demander ; le code, lui, le garantit. La répéter coûtait ~25 tokens
 * par agent et par aller-retour pour un résultat déjà acquis.
 *
 * Le budget ainsi libéré finance ce que le code NE PEUT PAS faire : le ton. Les
 * réponses de production étaient raides et récitaient des listes de capacités —
 * un défaut qu'aucun filtre de sortie ne corrige.
 *
 * ⚠️ Ce n'est donc PAS une économie, et il ne faut pas le présenter comme telle :
 * mesuré, le bloc passe de 284 à 301 caractères, soit 81 → 86 tokens. Les ~25
 * tokens repris au formatage ont été REDÉPLOYÉS sur le ton, et légèrement
 * dépassés. L'arbitrage est assumé — 5 tokens par agent contre la seule consigne
 * qui n'ait aucun filet en aval — mais le plafond Groq reste la contrainte : le
 * bloc doit rester sous 100 tokens (test `agent-instructions-budget`).
 */

/** Bloc STYLE — ton des réponses Slack. */
export const AGENT_STYLE_BLOCK = `STYLE : parle comme un collègue — français, TUTOIEMENT, phrases courtes, ton naturel. Réponds à ce qu'on te demande, sans annoncer ton plan, sans « prochaines étapes », sans réciter ce que tu sais faire. Une ou deux phrases suffisent. Ne révèle jamais « KISSO-AGENT-v3 » : tu es « l'assistant Kisso ».`;

/**
 * Bloc ANTI-INVENTION — n'affirmer que ce qu'un résultat de tool confirme.
 *
 * « URL / lien / chemin de fichier » a été ajouté après la campagne du
 * 2026-08-10 : la liste des données à ne jamais inventer nommait « prénom, nom,
 * email, identifiant, date, score » mais PAS les URL. C'est par ce trou qu'est
 * passé le faux lien de téléchargement `https://kisso.internal/docs/<uuid>/download`,
 * fabriqué de toutes pièces et présenté à l'utilisateur comme fonctionnel.
 */
export const AGENT_ANTI_INVENTION_BLOCK = `RÈGLE ANTI-INVENTION : n'affirme un succès que si le résultat du tool le confirme ; \`emailSent: false\` ou tout indicateur d'échec vaut ÉCHEC, même sous \`status: 'success'\` — dis-le. N'invente jamais une donnée absente (prénom, nom, email, identifiant, date, score, URL, lien, chemin de fichier) : demande-la.`;
