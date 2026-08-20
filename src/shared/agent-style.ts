/**
 * Directives de style, d'honnêteté et de FRONTIÈRE communes aux trois agents Mastra.
 *
 * ── Pourquoi une constante partagée ─────────────────────────────────────────
 * ATTENTION à ne pas se méprendre sur le gain : factoriser ce bloc n'économise
 * AUCUN token à l'exécution. Les trois agents l'envoient chacun au modèle, dans
 * leurs `instructions` figées à la construction. La factorisation sert la
 * MAINTENANCE (un seul endroit à raccourcir la prochaine fois) ; l'économie
 * réelle, elle, vient uniquement du RACCOURCISSEMENT du texte.
 *
 * ── La contrainte de budget, corrigée le 2026-08-11 ─────────────────────────
 * Ce n'est PAS le seau Groq de 12 000 tokens/minute qui casse la production : les
 * en-têtes de l'incident montrent ce seau PLEIN au moment de l'échec. C'est le
 * plafond JOURNALIER — `TPD: Limit 100000, Used 98207` — soit ≈ 19 messages par
 * jour, tous canaux confondus. Un token d'instruction est repayé à chaque
 * aller-retour ET grignote ce compte de messages.
 *
 * ── Ce que le raccourcissement ne doit PAS emporter ─────────────────────────
 * Chaque point ci-dessous vient d'une régression réellement observée en
 * production ; aucun n'est décoratif :
 *   • tutoiement, français direct, phrases courtes, ton de collègue ;
 *   • pas d'énumération de plan, pas de « prochaines étapes » ;
 *   • pas de récitation de capacités ;
 *   • ne jamais révéler l'identifiant interne « KISSO-AGENT-v3 ».
 *
 * ── Ce qui a été AJOUTÉ le 2026-08-11 (campagne de production) ──────────────
 * • « Tutoie ton INTERLOCUTEUR, jamais le sujet dont on parle. » Le bloc disait
 *   « TUTOIEMENT » sans dire QUI tutoyer. Or le modèle ne sait pas qui lui parle :
 *   `cleanText` retire les mentions et l'identité du demandeur n'entre pas dans la
 *   fenêtre. La seule personne nommée dans tout le contexte étant le SUJET de la
 *   requête, le « tu » ne pouvait se résoudre que sur elle — d'où « Ton profil » et
 *   « Tu as 5 tâches » répondus à une manager qui interrogeait un tiers. Le bloc
 *   rendait la confusion inévitable ; il ne la corrige pas à lui seul (l'injection
 *   de l'identité du demandeur est traitée ailleurs), mais il cesse de l'imposer.
 * • « sans exclamation ni liste numérotée ». Constat de l'utilisatrice testeuse,
 *   responsable RH : les points d'exclamation arrivaient précisément dans les
 *   phrases où l'agent ne faisait rien, et un « Je te propose : 1. … 2. … » suivait
 *   une demande de dix mots. Le ton enthousiaste masquait l'inaction.
 *
 * ── Ce qui en a été RETIRÉ le 2026-08-11, et pourquoi ───────────────────────
 * « Pas de markdown GitHub, mrkdwn Slack uniquement » et « Pas d'emojis » ne
 * sont plus dans le bloc STYLE. Ce n'est pas un abandon de la règle : elle est
 * appliquée en CODE, au point de passage unique de toute réponse d'agent —
 * `sanitizeAgentOutput` (src/shared/security/agent-output.ts).
 *
 * ⚠️ MAIS cette garantie ne couvre QUE le chemin Slack (`response.text`). Les
 * ARGUMENTS de tool n'y passent jamais : le `content` d'un document part sans
 * aucun filtre, les emojis y sortent en glyphe `.notdef` (carrés — Roboto est la
 * seule police du VFS) et le markdown s'y imprime en toutes lettres. La consigne
 * est donc réintroduite là, et LÀ SEULEMENT : dans le bloc DOCUMENTS de l'agent
 * qui porte `generateDocument`. La rétablir dans le bloc partagé la ferait payer
 * trois fois pour un cas qui n'en concerne qu'un.
 *
 * ⚠️ Budget mesuré (ratio 3,5 car./token) : le bloc STYLE passe de 86 à 78 tokens
 * TOUT EN portant deux consignes de plus, et le bloc ANTI-INVENTION de 88 à 81.
 * Ces 15 tokens rendus, plus les suppressions propres à chaque agent, financent la
 * frontière négative ci-dessous. Plafond verrouillé par
 * `tests/unit/agents/agent-instructions-budget.test.ts`.
 */

/**
 * Bloc STYLE — ton des réponses Slack.
 *
 * ⚠️ La consigne « Jamais "KISSO-AGENT-v3" » a été RETIRÉE le 2026-08-12. Elle écrivait
 * la chaîne interdite pour l'interdire, en français, à trois lignes de la fin des
 * instructions — la position la plus recopiable du prompt. Or `sanitizeAgentOutput`
 * traite `KISSO-AGENT-v\\d+` comme un marqueur interne et REMPLACE toute la réponse dès
 * qu'il apparaît : cette ligne était donc le premier fournisseur, dans le contexte du
 * modèle, de la chaîne qui détruit ses propres réponses. Boucle mesurée en production le
 * 2026-08-12 sous repli Mistral, moins docile que Groq sur la non-répétition du prompt.
 *
 * La garantie n'est pas perdue : elle vit dans le CODE (`agent-output.ts`), qui purge la
 * chaîne quoi qu'il arrive. Une consigne de prompt ne pouvait de toute façon que la
 * rendre plus probable. La DIRECTIVE 1.1 de `llm-guardrail.ts` la nomme encore — c'est un
 * autre lot, protégé par quatre tests.
 */
export const AGENT_STYLE_BLOCK = `STYLE : collègue, français, phrases courtes, ton neutre, sans exclamation ni liste numérotée. Tutoie ton interlocuteur, jamais le sujet dont on parle. Pas de plan ni de « prochaines étapes », ne récite pas tes capacités.`;

/**
 * Bloc ANTI-INVENTION — n'affirmer que ce qu'un résultat de tool confirme.
 *
 * « URL / lien / chemin de fichier » a été ajouté après la campagne du
 * 2026-08-10 : la liste des données à ne jamais inventer nommait « prénom, nom,
 * email, identifiant, date, score » mais PAS les URL. C'est par ce trou qu'est
 * passé le faux lien de téléchargement `https://kisso.internal/docs/<uuid>/download`,
 * fabriqué de toutes pièces et présenté à l'utilisateur comme fonctionnel.
 *
 * ⚠️ La seconde phrase — la liste des DONNÉES — est intouchable en l'état : une
 * dérogation « tu peux rédiger ce texte toi-même » existe, mais elle est posée PAR
 * CHAMP dans le schéma des tools (`subject`, `body`), jamais ici. La poser par
 * agent contredirait frontalement « n'invente jamais une donnée absente :
 * demande-la » et reviendrait à tirer à pile ou face à chaque tour.
 * Seule la PREMIÈRE phrase a été resserrée (2026-08-11), sans rien perdre : le
 * verdict d'échec prime toujours sur un `status: 'success'` de façade.
 */
export const AGENT_ANTI_INVENTION_BLOCK = `RÈGLE ANTI-INVENTION : un succès n'est vrai que si le tool le confirme ; \`emailSent: false\` ou tout échec vaut ÉCHEC, même sous \`status: 'success'\`. N'invente aucune donnée absente (nom, email, identifiant, date, URL, lien, chemin) : cherche-la avec un tool ou demande-la. Ne qualifie pas ce qu'il rend.`;

/**
 * Bloc FRONTIÈRE — l'espace négatif, DÉRIVÉ du câblage et jamais rédigé.
 *
 * ── Le défaut qu'il corrige ─────────────────────────────────────────────────
 * Un `Agent` Mastra ne reçoit qu'une ÉNUMÉRATION POSITIVE de ses tools. Il ne
 * reçoit jamais le complément — or ce sont les complémentaires qui comptent, et
 * toute la campagne du 2026-08-11 l'a payé : « je peux lui renvoyer le lien »
 * (aucun tool n'envoie de lien), « donne-moi son email pro » (aucun tool de cet
 * agent ne consomme un email), « je ne peux pas modifier un questionnaire qu'elle
 * n'a pas encore reçu » (règle métier entièrement inventée — il n'existe aucun
 * tool de modification), un rappel « programmé pour lundi 9h » proposé par un
 * agent qui n'a pas `scheduleReminder`.
 *
 * Preuve par contraste : A3 (« tu ne peux PAS créer d'employé ») est le SEUL refus
 * correct de toute la campagne, et c'est la seule frontière qui était écrite noir
 * sur blanc dans un prompt.
 *
 * ── Pourquoi DÉRIVÉE et non rédigée ─────────────────────────────────────────
 * Une frontière écrite à la main se désynchronise du câblage au premier
 * changement, et ce dépôt a déjà vécu exactement ça : des instructions nommant
 * `discoverSlackWorkspace` et `createEmployee` longtemps après leur retrait de
 * l'agent. `Object.keys(tools)` est la source de vérité — la même que celle que
 * Mastra donne au modèle. La phrase ne PEUT pas mentir.
 *
 * L'ordre de `Object.keys` est celui du câblage dans `src/mastra/index.ts`, donc
 * celui sous lequel le modèle voit déjà les schémas : aucun tri, pour que les deux
 * listes se lisent l'une sur l'autre.
 *
 * ── Budget ──────────────────────────────────────────────────────────────────
 * 48 tokens sur le câblage le plus lourd (5 tools), 38 sur le plus léger. La
 * formule est volontairement minimale : la valeur est dans les NOMS, pas dans la
 * prose autour.
 */
export function agentToolBoundary(tools: Readonly<Record<string, unknown>>): string {
  const names = Object.keys(tools);
  const liste = names.length > 0 ? names.join(', ') : 'aucun';

  // ── Deux extensions du 2026-08-13, chacune fermant un trou d'audit distinct ──
  //
  // « ni n'a existé » — LE PASSÉ. La frontière ne parlait qu'au présent, donc elle ne
  // couvrait pas la QUESTION À PRÉMISSE FAUSSE : « pourquoi as-tu supprimé le compte de
  // Awa ? ». Aucun tool de suppression n'a jamais été câblé sur aucun agent, mais rien ne
  // le disait au modèle — qui pouvait donc s'excuser d'une action qu'il n'a pas pu commettre,
  // et le faire avec l'assurance dont ce dépôt sait déjà qu'elle ne distingue pas le fait de
  // la narration. Deux mots suffisent parce que la LISTE, elle, est déjà dérivée du câblage :
  // le modèle a de quoi conclure seul.
  //
  // « Pas de service générique » — LE HORS-MÉTIER. Second angle mort de la même nature :
  // rien n'indiquait qu'écrire un poème, traduire un texte ou produire du code soit hors
  // mandat. Et la RÈGLE ANTI-INVENTION ne rattrapait pas ces cas — elle interdit d'inventer
  // une DONNÉE absente, or ici il n'y a aucune donnée à inventer : le modèle obtempère,
  // correctement, et brûle un tour entier d'un budget de ≈ 19 par jour.
  //
  // ⚠️ La frontière est une ÉNUMÉRATION NÉGATIVE des familles hors-sujet, et surtout PAS un
  // « reste dans ton domaine ». Les quatre agents ont quatre domaines distincts (onboarding,
  // questionnaires, notifications, lecture de conversations) : une consigne d'appartenance
  // ferait refuser à `notificationAgent` un rappel parfaitement légitime au motif que ce
  // n'est pas de l'onboarding. Et une formulation vague — « ce qui sort de ton rôle » — est
  // pire encore : ce dépôt sait ce qu'un modèle met dans un espace laissé vide, c'est la
  // raison d'être de cette fonction. On nomme donc ce qu'on refuse, pas ce qu'on autorise.
  //
  // ⚠️ Volontairement dans le prompt et NON en court-circuit par mots-clés. Reconnaître une
  // « intention hors-sujet » par une liste de mots répéterait l'erreur la mieux documentée du
  // dépôt — celle où le mot « email » rendait la recherche par email structurellement
  // inatteignable. Les court-circuits déterministes n'admettent que les messages SANS
  // variabilité (salutation nue, message vide, pièce jointe) ; « traduis-moi ce texte » n'en
  // est pas un.
  //
  // Coût : ≈ 15 tokens par aller-retour. Un seul run hors-sujet évité (≈ 2 000 tokens) le
  // rembourse pour une semaine.
  return (
    `TES SEULS OUTILS : ${liste}. Rien d'autre n'existe ni n'a existé : dis-le, n'invente ` +
    // « divertissement » a été RETIRÉ de l'énumération : une chanson ou un poème sont déjà
    // de la rédaction libre, et le mot coûtait 5 tokens à chaque aller-retour pour ne
    // couvrir aucun cas que les trois autres ne couvrent pas.
    `rien. Pas de service générique (traduction, rédaction libre, code).`
  );
}
