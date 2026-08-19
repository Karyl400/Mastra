/**
 * Réconciliation FAIT / NARRATION — le handler est le seul point qui voit à la fois la
 * réponse du modèle et sa trace d'exécution ; ce module sait les confronter.
 *
 * ## Pourquoi un module de DOMAINE
 *
 * Extrait de `slack-events.handler.ts` le 2026-08-17. Rien ici ne touche Slack, ni un
 * dépôt, ni Mastra : ce sont des prédicats purs sur du texte et sur une liste de noms
 * d'outils. C'est la définition même d'un service de domaine — et cela rend enfin
 * possible de le tester sans construire un handler entier, ce qui exigeait jusqu'ici de
 * neutraliser quatre dépendances de base.
 *
 * Le garde-fou lui-même répond au verdict de l'utilisatrice testeuse : « il parle
 * exactement de la même façon quand il a fait le travail et quand il l'a inventé ».
 */

const DONE_VERBS =
  '(?:envoye|cree|genere|enregistre|programme|planifie|transmis|transmise|ajoute|publie|telecharge)';

/**
 * Formules affirmant qu'une action A EU LIEU.
 *
 * Le critère d'admission est strict : la formule doit être FAUSSE PAR CONSTRUCTION si aucun
 * outil n'a tourné. « Je peux t'envoyer… », « Veux-tu que je t'envoie… », « Il faudra
 * créer… » n'en sont pas — ce sont des propositions, et les inclure transformerait chaque
 * tour de conversation ordinaire en accusation.
 *
 * Formules relevées telles quelles sur la campagne du 2026-08-11 : « C'est fait ! »,
 * « Ton Guide en PDF est prêt », « t'a été envoyé ».
 */
const ACCOMPLISHMENT_CLAIMS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "c'est fait", pattern: /\bc'est (?:fait|bon|parti|envoye)\b/ },
  {
    label: 'première personne',
    pattern: new RegExp(
      `\\b(?:j'ai|je t'ai|je l'ai|je lui ai|je vous ai|je les ai) (?:bien |deja )?${DONE_VERBS}e?s?\\b`,
    ),
  },
  {
    label: 'je viens de',
    pattern:
      /\bje viens (?:de |d')(?:t'|l'|lui |vous |les )?(?:envoyer|creer|generer|enregistrer|programmer|planifier|transmettre|ajouter|publier)\b/,
  },
  {
    label: 'voix passive',
    pattern: new RegExp(`\\b(?:a|ont|t'a|lui a|vous a) (?:bien |deja )?ete ${DONE_VERBS}e?s?\\b`),
  },
  { label: 'est prêt', pattern: /\best (?:pret|prete|prets|pretes)\b/ },
  // ── Famille MISE À JOUR, ajoutée le 2026-08-13 sur relevé de production ──
  //
  //     Karyl  : « @Mastra ajoute en une quatrième »
  //     Mastra : « Le quiz "Quiz sur nos valeurs" est maintenant à jour avec une
  //               quatrième question. »
  //
  // **Aucun outil de modification de questionnaire n'existe dans ce dépôt.** La phrase est
  // donc fausse par construction — le critère d'admission exact de cette liste — et elle
  // passait entre les mailles : ni « c'est fait », ni voix passive avec un verbe de
  // `DONE_VERBS`, ni « est prêt ». Le tour d'avant, le même agent avait déjà annoncé
  // « Ok, je la remplace par : … » sur le même questionnaire inexistant.
  //
  // Le verbe `mis à jour` n'est PAS ajouté à `DONE_VERBS` : il y entrerait dans la voix
  // passive (« a été mis à jour ») mais raterait « est maintenant à jour », qui est la
  // forme réellement relevée — un ADJECTIF, pas un participe.
  {
    label: 'mise à jour',
    pattern:
      /\b(?:est|sont) (?:maintenant |desormais |bien )?(?:a jour|mis a jour|mise a jour|mises a jour)\b/,
  },
];

/**
 * Outils qui ne font que LIRE. Une annonce d'accompli qu'ils seraient seuls à étayer est
 * fausse par construction : lire ne produit rien.
 *
 * ## Pourquoi cette liste existe — le garde-fou était désarmé dans le cas COURANT
 *
 * La réconciliation ne s'armait que sur `toolCalls.length === 0`. Or le premier geste de
 * presque tout run est une lecture — `findEmployeeByEmail` pour résoudre une personne,
 * `getEmployeeProfile` pour situer son parcours. Un seul de ces appels portait la longueur à
 * 1 et **désactivait la détection pour tout le tour**. Le défaut numéro un formulé par
 * l'utilisatrice testeuse — « il parle exactement de la même façon quand il a fait le travail
 * et quand il l'a inventé » — restait donc entier partout où il se manifestait vraiment.
 *
 * Ce qui contredit une annonce d'accompli n'est pas « zéro outil », c'est « zéro outil qui
 * AGIT ».
 *
 * ## Pourquoi une liste de LECTEURS, et non une liste d'ACTEURS
 *
 * Le défaut sûr doit être le SILENCE. Un outil inconnu de cette liste est traité comme un
 * acteur, donc n'accuse jamais : un nouvel outil non classé, ou un nom de tool illisible
 * (Mastra a déjà changé la forme de ce champ une fois — `readToolCalls` journalisait
 * « unknown » sur 100 % des appels), produit au pire un silence, jamais une accusation à
 * tort. L'inverse — lister les acteurs — ferait qu'un oubli de classement accuse le modèle
 * d'avoir menti alors qu'il a réellement agi.
 *
 * ⚠️ Verrouillé par `tests/unit/quality/tool-classification.test.ts` : tout outil câblé dans
 * `src/mastra/index.ts` doit être classé ici OU être un acteur assumé. Une liste écrite à la
 * main se désynchronise au premier changement de câblage — ce dépôt en a déjà fait deux fois
 * l'expérience, avec des instructions nommant des tools retirés depuis longtemps.
 */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'findEmployeeByEmail',
  'getEmployeeProfile',
  'getTaskList',
  'getNotificationHistory',
  'getUserConversations',
  'getChannelHistory',
]);

/**
 * Un outil susceptible d'AGIR a-t-il tourné ?
 *
 * `[]` (zéro appel) rend `false` — c'est le cas d'origine, conservé. Un nom absent de
 * `READ_ONLY_TOOL_NAMES` rend `true` : voir l'arbitrage ci-dessus, l'inconnu ne doit jamais
 * produire une accusation.
 */
export function hasActingToolCall(toolCalls: readonly string[]): boolean {
  return toolCalls.some((name) => !READ_ONLY_TOOL_NAMES.has(name));
}

/**
 * Note ACCOLÉE à la réponse quand elle annonce un accompli qu'aucun outil n'étaye.
 *
 * ## Arbitrage : requalifier, pas bloquer
 *
 * Remplacer la réponse entière serait brutal et faux dans un cas légitime : le modèle peut
 * dire « c'est fait » en parlant d'un tour PRÉCÉDENT, où l'outil avait bel et bien tourné.
 * La détection porte sur le tour courant, pas sur l'historique — elle ne peut donc pas
 * trancher ce cas, et une réponse par ailleurs exploitable serait détruite.
 *
 * On applique le même arbitrage que pour un lien fabriqué (`sanitizeAgentOutput`) : le mal
 * est LOCAL, on le corrige localement. Ici le mal n'est pas une phrase à retirer mais une
 * ambiguïté à lever — d'où une note, et non une suppression. Elle dit exactement ce que le
 * système SAIT (« aucune action à ce tour »), jamais ce qu'il suppose.
 *
 * Le verdict complet part en `error` dans les logs, comme pour les URL fabriquées.
 */
export const UNSUPPORTED_CLAIM_NOTICE =
  "\n\n_Note : aucune action n'a été exécutée à ce tour. Si tu attendais un envoi, un document ou un enregistrement, il n'a pas eu lieu._";

/** Minuscules, accents et apostrophes typographiques normalisés — la comparaison s'y fait. */
export function normalizeForClaims(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/’/g, "'");
}

/**
 * Étiquette de la formule d'accompli trouvée, ou `null`.
 *
 * Ne dit RIEN de la véracité : c'est l'appelant qui confronte ce verdict à la trace
 * d'exécution. Fonction pure, donc éprouvable des deux côtés.
 */
export function detectUnsupportedCompletionClaim(text: string): string | null {
  const normalized = normalizeForClaims(text);
  return ACCOMPLISHMENT_CLAIMS.find((claim) => claim.pattern.test(normalized))?.label ?? null;
}

/**
 * Noms des outils réellement appelés, ou `null` si la trace est illisible.
 *
 * ⚠️ La distinction `null` / `[]` est TOUT le contrat : `[]` prouve que zéro outil a tourné,
 * `null` dit seulement qu'on ne sait pas. Confondre les deux ferait accuser le modèle sur un
 * changement de forme de Mastra.
 *
 * Forme réelle vérifiée dans `@mastra/core` (`trip-wire-*.js`) : `toolCalls` est un tableau
 * de CHUNKS `{ type: 'tool-call', payload: { toolCallId, toolName, args } }`. L'ancienne
 * lecture `call.toolName ?? call.name` rendait donc « unknown » sur 100 % des 19 runs de
 * production mesurés — la longueur était juste, le nom jamais. Les deux formes plates sont
 * conservées en repli : l'observabilité ne doit jamais faire échouer une réponse produite.
 */
export function readToolCallNames(response: unknown): string[] | null {
  const calls = (response as { toolCalls?: unknown } | undefined)?.toolCalls;
  if (!Array.isArray(calls)) return null;

  return calls.map((call) => {
    const chunk = call as { payload?: { toolName?: unknown }; toolName?: unknown; name?: unknown };
    return String(chunk.payload?.toolName ?? chunk.toolName ?? chunk.name ?? 'unknown');
  });
}

/**
 * Où répondre, et donc quelle est la clé du fil.
 *
 * En canal, on threade systématiquement (thread existant, sinon on en ouvre un sur ce
 * message). En DM, threader enfouit la réponse hors de la conversation principale — le bot a
 * semblé silencieux pendant des heures en production pour cette raison exacte. On ne threade
 * donc un DM QUE si le message d'origine faisait DÉJÀ partie d'un thread (`thread_ts` présent
 * et différent de `ts` ; sinon `thread_ts` == `ts` == la racine du message courant, pas un
 * vrai thread existant).
 */

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA PROMESSE D'AVENIR — le symétrique de tout ce qui précède
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Tout ce module guette l'ACCOMPLI non appuyé par un outil. Il est aveugle à la faute
 * inverse, mesurée en production le 2026-08-18 :
 *
 *     « Le rappel a été enregistré. **Il sera envoyé à Karyl par email le 20 août 2026
 *       à 09 h 00**, avec le sujet … »
 *
 * L'accompli y est VRAI — `scheduleReminder` a bel et bien tourné, la ligne existe. C'est la
 * suite qui est fausse : il n'existe ni cron ni poller dans ce système, et `findPending()`
 * n'a aucun site d'appel. Rien ne partira, jamais. `detectUnsupportedCompletionClaim` se tait
 * par conception, puisqu'un outil a tourné — la contradiction n'est pas entre la phrase et la
 * trace, elle est entre la phrase et le CÂBLAGE.
 *
 * ⚠️ **La consigne de prompt a été essayée d'abord, et mesurée en échec le même jour.**
 * « Un rappel est seulement ENREGISTRÉ : aucun automate ne l'enverra, dis-le sans détour » a
 * été ajoutée au `notificationAgent` puis déployée ; la réponse suivante en production a été
 * PIRE qu'avant — elle a gagné une date et une heure d'envoi précises. Le mot `scheduledAt`
 * du tool-result pèse plus lourd qu'une ligne d'instruction, et c'est la règle que ce dépôt
 * connaît déjà : « le mot que lit le modèle est celui qu'il répétera ». Une consigne est
 * PROBABLE ; le code est GARANTI. Même issue que le champ `coverage`, ignoré deux fois.
 */

/**
 * Outils qui écrivent une intention SANS jamais la transporter.
 *
 * ⚠️ Liste volontairement MINUSCULE, et son critère est vérifiable : y figure un outil dont
 * le résultat porte `willBeSentAutomatically: false`. Y ajouter un outil qui livre vraiment
 * ferait démentir des réponses justes — le pire défaut possible pour un garde-fou d'honnêteté.
 */
const NON_DELIVERING_TOOL_NAMES: ReadonlySet<string> = new Set(['scheduleReminder']);

/**
 * Toutes les actions du tour sont-elles des enregistrements sans transport ?
 *
 * ⚠️ Faux dès qu'un outil INCONNU a tourné, exactement comme `hasActingToolCall` : l'inconnu
 * ne doit jamais produire une accusation. Et faux sur `[]`, où c'est l'autre détecteur qui
 * parle — sans cela les deux notes s'accoleraient à la même réponse.
 */
export function onlyNonDeliveringTools(toolCalls: readonly string[]): boolean {
  const acting = toolCalls.filter((name) => !READ_ONLY_TOOL_NAMES.has(name));
  return acting.length > 0 && acting.every((name) => NON_DELIVERING_TOOL_NAMES.has(name));
}

/**
 * Formules d'ENVOI À VENIR. Liste FERMÉE, même discipline que `ACCOMPLISHMENT_CLAIMS` : on
 * cherche une CONTRADICTION avec le câblage, jamais une invraisemblance.
 *
 * Volontairement ABSENTS :
 *  - « je peux l'envoyer », « veux-tu que je l'envoie » — une OFFRE n'est pas une promesse,
 *    et c'est le même critère qui a toujours épargné « je peux t'envoyer… » à l'autre
 *    détecteur ;
 *  - le passé (« a été envoyé ») — c'est le domaine de `ACCOMPLISHMENT_CLAIMS`, et le
 *    couvrir ici accolerait deux notes à la même phrase.
 */
/** Pronoms enclitiques français, dans l'ordre où ils s'empilent : « je **le lui** enverrai ». */
const ENCLITIC = "(?:(?:le|la|lui|les|leur|vous) |t')";

/** Verbes d'envoi au futur de la première personne. */
const SEND_VERBS_FUTURE = 'enverrai|transmettrai|expedierai|adresserai';

const FUTURE_DELIVERY_CLAIMS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: 'sera envoyé',
    pattern:
      /\b(?:sera|seront) (?:bien |automatiquement )?(?:envoye|transmis|expedie|adresse|delivre)/,
  },
  { label: 'partira', pattern: /\b(?:partira|partiront)\b/ },
  {
    // ⚠️ AJOUTÉ le 2026-08-19 après mesure en production. `notificationAgent` a répondu
    // « Rappel PLANIFIÉ : … » alors que `scheduleReminder` rend explicitement
    // `willBeSentAutomatically: false` et que sa description dit « enregistre ». Le mot qui
    // compte pour la personne est celui-là, et il promettait un envoi qui n'aura jamais lieu :
    // il n'existe dans ce dépôt ni cron, ni poller, ni site d'appel de `findPending()`.
    //
    // Il n'est PAS ambigu ici : ce détecteur ne parle que si le seul outil ayant tourné est un
    // enregistreur sans transport (`onlyNonDeliveringTools`).
    label: 'planifié',
    pattern: /\bplanifiee?s?\b/,
  },
  {
    // Même famille, formulée du côté du destinataire. « Tu recevras un rappel lundi » est la
    // promesse la plus concrète que ce système ne peut pas tenir.
    label: 'tu recevras',
    pattern: /\btu (?:recevras|seras (?:prevenu|notifie))/,
  },
  {
    label: "je l'enverrai",
    // ⚠️ Les pronoms sont RÉPÉTABLES : « je **le lui** enverrai » en empile deux, et un seul
    // groupe optionnel laissait passer la phrase la plus naturelle des trois. Attrapé par le
    // test avant tout déploiement — c'est le même défaut de bord que `\b` en ASCII, sous une
    // autre forme : un motif qui échoue en silence sur la moitié des tournures.
    // ⚠️ DEUX groupes optionnels INDÉPENDANTS, jamais un quantificateur imbriqué
    // (`(?:… ?){0,2}`) : ce dernier était borné à deux, donc inoffensif, mais il déclenchait
    // `security/detect-unsafe-regex` — et ce dépôt a ramené son lint à ZÉRO warning le
    // 2026-08-18. Une exception ajoutée ici rendrait la règle inaudible ailleurs.
    //
    // Composé à partir d'une constante plutôt qu'écrit à plat : la même alternation répétée
    // deux fois portait la complexité du littéral à 23 pour un plafond de 20, et une liste
    // recopiée diverge de toute façon à la première modification. Même idiome que
    // `matchesKeyword` — la source est INTERNE, jamais un texte d'utilisateur (la règle
    // `detect-non-literal-regexp` ne s'en émeut d'ailleurs pas : les deux fragments sont des
    // constantes de ce module, pas des paramètres).
    // Mesuré : 0,02 ms sur 8 000 pronoms empilés.
    pattern: new RegExp(`\\bje ${ENCLITIC}?${ENCLITIC}?(?:${SEND_VERBS_FUTURE})\\b`),
  },
  { label: 'recevra', pattern: /\b(?:recevra|recevront)\b/ },
];

/**
 * Ce qui DÉSAMORCE une promesse : un envoi conditionné à un geste humain est VRAI.
 *
 * C'est exactement le contrat de la carte de recrutement — « il ne partira qu'après ton clic
 * sur Envoyer » — et y accoler une note de démenti transformerait ce garde-fou en défaut. La
 * fenêtre est le message entier : la condition est souvent posée dans une autre phrase que la
 * promesse.
 */
const HUMAN_GATED_PATTERN =
  /\b(?:apres|qu'apres|une fois) (?:ton |votre |le |la )?(?:clic|validation|confirmation)|\bne part(?:ira)? qu'apres\b|\bclic sur\b/;

/**
 * Note ACCOLÉE quand la réponse promet un envoi que rien n'exécutera.
 *
 * ⚠️ Contrat DIFFÉRENT de `UNSUPPORTED_CLAIM_NOTICE`, et la différence est le fond du
 * correctif : là-bas rien n'a été exécuté, ici l'enregistrement a bel et bien eu lieu. Écrire
 * « aucune action n'a été exécutée » serait faux et détruirait la seule partie vraie du
 * message. On dément la SUITE, pas le FAIT.
 *
 * En mrkdwn Slack (`_italique_`), jamais en markdown GitHub : les textes en dur ne passent
 * par aucun filtre — `sanitizeAgentOutput` n'a qu'un seul site d'appel, `response.text`.
 */
export const PROMISED_DELIVERY_NOTICE =
  "\n\n_Note : c'est enregistré, mais aucun automate ne l'enverra — il n'y en a aucun dans ce système. Reviens me le demander le moment venu._";

/**
 * Étiquette de la promesse d'envoi trouvée, ou `null`. Fonction PURE : c'est l'appelant qui
 * la confronte à la trace d'exécution, exactement comme pour l'accompli.
 */
export function detectUnsupportedDeliveryPromise(text: string): string | null {
  const normalized = normalizeForClaims(text);
  if (HUMAN_GATED_PATTERN.test(normalized)) return null;
  return FUTURE_DELIVERY_CLAIMS.find((claim) => claim.pattern.test(normalized))?.label ?? null;
}
