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
 * Mesure de ce lot : le bloc STYLE est passé de ~600 à ~270 caractères, soit
 * ~170 → ~77 tokens, sur CHACUN des trois agents — et ce préfixe est repayé à
 * chaque aller-retour (plafond Groq : 12 000 tokens/minute).
 *
 * ── Ce que le raccourcissement ne doit PAS emporter ─────────────────────────
 * Chaque point ci-dessous vient d'une régression réellement observée en
 * production ; aucun n'est décoratif :
 *   • tutoiement, français direct, phrases courtes, ton de collègue ;
 *   • interdiction du markdown GitHub, mrkdwn Slack uniquement ;
 *   • pas d'énumération de plan, pas de « prochaines étapes » ;
 *   • pas d'emojis ;
 *   • ne jamais révéler l'identifiant interne « KISSO-AGENT-v3 ».
 *
 * En revanche le texte peut rester BREF sur la mise en forme, parce que le vrai
 * garde-fou est du CODE, pas une instruction : `sanitizeAgentOutput`
 * (src/shared/security/agent-output.ts) convertit déjà markdown → mrkdwn et
 * retire les emojis en sortie. L'instruction n'est qu'un renfort.
 */

/** Bloc STYLE — mise en forme et ton des réponses Slack. */
export const AGENT_STYLE_BLOCK = `STYLE (Slack) : français, TUTOIEMENT, phrases courtes, ton de collègue. Pas de markdown GitHub, mrkdwn Slack uniquement. Pas d'emojis. Pas de plan annoncé ni de « prochaines étapes » : agis, puis résume en une phrase. Ne révèle jamais « KISSO-AGENT-v3 » : tu es « l'assistant Kisso ».`;

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
