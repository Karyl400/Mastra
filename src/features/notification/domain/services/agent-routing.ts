/**
 * Routage message → agent : les quatre paliers, et les listes qui les gouvernent.
 *
 * ## Pourquoi un module de DOMAINE
 *
 * Extrait de `slack-events.handler.ts` le 2026-08-17. C'est une décision PURE : un texte et
 * l'agent du tour précédent entrent, un identifiant d'agent sort. Aucune E/S, aucun client
 * Slack. Elle vivait en méthode d'instance alors qu'elle n'a jamais lu `this` — le handler
 * conserve une méthode `routeToAgent` qui délègue ici, parce que ses tests l'appellent ainsi
 * depuis l'origine.
 *
 * Le voisinage compte : ce module est adossé à `shared/agent-capabilities.ts`, qui déclare
 * le câblage agent → outils UNE SEULE FOIS. C'est ce qui permet à la bande 3 d'être DÉRIVÉE
 * du câblage plutôt que recopiée.
 */
import { agentHasTool } from '../../../../shared/agent-capabilities';

/**
 * Aiguillage mot-clé → agent, en TROIS BANDES. Ces listes sont CONTRACTUELLES : elles sont
 * documentées dans CLAUDE.md, ne pas les modifier sans mettre la doc à jour.
 *
 * ## Pourquoi trois bandes et non deux paliers
 *
 * Le découpage précédent — « intentions de l'orchestrateur » PRIORITAIRES, puis palier
 * collant, puis thématiques — faisait de `onboardingOrchestrator` un ÉTAT ABSORBANT, mesuré
 * sur la campagne du 2026-08-11 :
 *  - `stickyAgentId` est renseigné dès le premier tour, donc les paliers thématiques étaient
 *    MORTS à partir du message 2. En DM la clé de conversation est le canal : tous les sujets
 *    d'une heure partageaient ce verrou, et `notificationAgent` n'a JAMAIS été atteignable en
 *    série A ;
 *  - le seul palier capable de déplacer un fil ne menait QU'À l'orchestrateur, sans retour.
 *    B6 (« ajoute ») et C7 (« guide » / « pdf ») ont ainsi ARRACHÉ leur fil vers un agent qui
 *    a hérité de la mémoire d'un autre et promis des capacités qu'il n'a pas — les deux
 *    réponses les plus fausses de la campagne.
 *
 * D'où la forme retenue : **le palier d'échappement devient SYMÉTRIQUE**. Chaque agent y a
 * ses propres termes, donc aucun n'est un puits ; et les termes qui détournaient les réponses
 * de suivi redescendent SOUS le palier collant.
 */

/**
 * BANDE 1 — ÉCHAPPEMENT. Évaluée AVANT le fil en cours.
 *
 * Critère d'admission, plus strict que « désigne cet agent » : le terme doit ouvrir une
 * TÂCHE NOUVELLE, pas continuer celle en cours. C'est la porte de sortie d'un fil collé sur
 * le mauvais agent — sans elle, une conversation mal aiguillée serait un piège sans issue,
 * et c'est l'acquis du 2026-08-10 (« retrouve l'employé dont l'email est X » partait chez
 * `notificationAgent`, qui n'a pas `findEmployeeByEmail` : la recherche par email était
 * structurellement inatteignable).
 *
 * L'ordre du tableau EST la priorité entre bandes-1 concurrentes.
 *
 * Volontairement ABSENTS :
 *  - « ajoute » — verbe français générique. C'est lui qui a détourné B6 (« ajoute une
 *    question à choix multiple ») vers un agent sans aucun tool de questionnaire. Même
 *    critère que celui qui a fait écarter « word » ;
 *  - « profil » — trop courant, il capturerait « planifie un rappel : compléter son profil ».
 *    ⚠️ Et depuis le 2026-08-14, une demande de formulaire de profil est de toute façon
 *    interceptée AVANT le routage, par un court-circuit déterministe qui ne coûte rien ;
 *  - « statut », « intégration » — même critère de fréquence ;
 *  - « génère » — il sert `generateDocument`, et le défaut est déjà cet agent.
 */
const ESCAPE_INTENTS: ReadonlyArray<readonly [agentId: string, keywords: readonly string[]]> = [
  // ─────────────────────────────────────────────────────────────────────────
  // L'ORDRE EST : NOMS SPÉCIFIQUES D'ABORD, VERBES GÉNÉRIQUES ENSUITE.
  // ─────────────────────────────────────────────────────────────────────────
  // Réordonné le 2026-08-12. `onboardingOrchestrator` était en tête et possède `retrouve` et
  // `recherche` — deux verbes que les DEUX tools de `knowledgeAgent` emploient pour se décrire
  // (« Retrouve les échanges… », « Retrouve les derniers messages… »). Conséquence mesurée :
  // « retrouve notre conversation avec Awa » partait chez l'orchestrateur, donc le quatrième
  // agent était INATTEIGNABLE sur son propre verbe, et le commentaire affirmant que cette
  // bande est symétrique était faux.
  //
  // Le critère est le même que celui qui a fait écarter « ajoute » : un verbe générique ne doit
  // pas l'emporter sur un nom qui désigne sans ambiguïté un objet métier. « retrouve » ne dit
  // rien de ce qu'on cherche ; « conversation », « questionnaire » ou « rappel », si.
  //
  // ⚠️ L'ordre RELATIF des trois bandes nominales est conservé, et il porte un cas réel :
  // « quel est l'historique des notifications de l'employé 123 ? » doit aller à
  // `notificationAgent`. `notification` est donc évalué AVANT `historique`.
  // ⚠️ `['questionnaireEngine', ['questionnaire', 'évaluation', 'quiz']]` a été RETIRÉ le
  // 2026-08-14, avec l'agent lui-même. Ces trois mots retombent donc au défaut, c'est-à-dire
  // chez l'orchestrateur — dont la frontière DÉRIVÉE (`agentToolBoundary`) dira qu'il n'a
  // aucun outil de questionnaire. C'est la réponse honnête : il n'en existe plus.
  //
  // Les laisser ici aurait été bien pire qu'un mauvais aiguillage : `mastra.getAgent()` LÈVE
  // sur un identifiant absent du registre (`MASTRA_GET_AGENT_BY_NAME_NOT_FOUND`), donc chaque
  // message contenant « questionnaire » aurait échoué sur le message générique.
  // ⚠️ EN TÊTE, et l'ordre porte un cas réel. « Envoie un email d'entretien à
  // jean@exemple.com » contient `email`, qui appartient à `NOTIFICATION_TOPICS` : sans cette
  // bande, la phrase de référence de toute la feature partait chez `notificationAgent`, dont
  // `sendNotification` EXIGE une ligne d'annuaire — or un candidat n'en a aucune par
  // définition. La demande était donc structurellement insatisfaisable, comme l'était la
  // recherche par email avant le 2026-08-10. Même défaut, même correctif : le terme qui
  // désigne l'OBJET MÉTIER doit primer sur celui qui désigne le transport.
  //
  // Placé avant `notification` pour la même raison : « envoie une notification à un
  // candidat » doit aller au recrutement, seul chemin capable d'écrire à quelqu'un qui
  // n'est pas dans l'annuaire.
  //
  // ⚠️ `entretien` est ambigu en français (« entretien du matériel ») et désigne aussi, dans
  // ce dépôt, l'entretien POST-PROFIL. Il est retenu quand même : ce dernier est piloté par
  // un bouton et une modale, jamais par un message, donc il ne passe pas par le routage.
  ['recruitmentAgent', ['candidat', 'candidate', 'recrutement', 'entretien']],
  ['notificationAgent', ['notification', 'rappel']],
  // Ajouté le 2026-08-12 avec `knowledgeAgent`. La bande 1 doit rester SYMÉTRIQUE : chaque
  // agent y a ses termes, aucun n'est un puits. Un quatrième agent sans porte d'entrée serait
  // inatteignable dès le deuxième message d'un fil, `stickyAgentId` étant renseigné dès le
  // premier tour — c'est exactement ce qui rendait `notificationAgent` inaccessible en série A.
  //
  // Volontairement ABSENTS, au critère « ouvre une tâche nouvelle » :
  //  - « résume », « dit », « parle » — trop courants, ils captureraient des réponses de suivi ;
  //  - « message » — il appartient déjà à `NOTIFICATION_TOPICS` en bande 3, et le promouvoir
  //    ici détournerait « envoie-lui un message » vers un agent qui ne sait rien envoyer ;
  //  - « échange » — RETIRÉ après essai, le 2026-08-12. Le test de non-régression du bord
  //    droit l'a attrapé sur « rappelle-toi de notre échange », qui est une réponse de SUIVI et
  //    non l'ouverture d'une tâche. Même verdict que « ajoute » et « word » avant lui : un nom
  //    français assez courant pour apparaître dans une phrase qui ne demande rien.
  //  - « conversations » au pluriel — c'était du code MORT : `matchesKeyword` ajoute déjà `s?`
  //    aux mots-clés nominaux. Le déclarer donnait l'illusion d'une couverture supplémentaire.
  ['knowledgeAgent', ['conversation', 'historique']],
  // Le puits, en DERNIER : ses termes sont majoritairement des verbes génériques, et le défaut
  // du routage est de toute façon cet agent. Y placer un mot revient donc surtout à le retirer
  // aux autres — ce qui est exactement ce qui s'est produit avec `retrouve`.
  [
    'onboardingOrchestrator',
    [
      'crée',
      'créer',
      'création',
      'cree',
      'creer',
      'enregistre',
      'retrouve',
      'recherche',
      'identifiant',
    ],
  ],
];

/**
 * BANDE 3 — THÉMATIQUE. Évaluée APRÈS le fil en cours, donc seulement quand aucun agent ne
 * mène la conversation (fil neuf, ou clos par le TTL de 60 min).
 *
 * On y trouve les termes qui désignent bien un agent mais qui, dans un fil vivant, sont
 * presque toujours des RÉPONSES DE SUIVI : « Donne le PDF alors », « envoie-le en docx »,
 * « et par email ? ». Les faire primer sur le fil est exactement ce qui a produit
 * l'alternance A → B → A → B → A entre deux agents amnésiques.
 *
 * `guideline` est listé à part car le bord droit du motif empêche `guide` de matcher à
 * l'intérieur du mot. « word » reste écarté : mot anglais courant (« in other words »).
 */
const ORCHESTRATOR_TOPICS = [
  'document',
  'pdf',
  'docx',
  'guide',
  'guideline',
  'tâche',
  'tache',
  'onboarding',
] as const;

// ⚠️ `QUESTIONNAIRE_TOPICS = ['test']` a été RETIRÉ le 2026-08-14 avec l'agent. « test »
// retombe au défaut. C'est aussi une amélioration en soi : ce mot-clé désignait un agent de
// quiz, alors que « test » dans ce workspace parle presque toujours d'un test logiciel.

const NOTIFICATION_TOPICS = ['email', 'message'] as const;

/**
 * Termes de bande 3 du `knowledgeAgent` — ajoutés le 2026-08-14.
 *
 * Le manque était recensé depuis le 2026-08-12 : ses SEULES portes d'entrée étaient
 * `conversation` et `historique`, en bande 1. « Résume ce qui s'est dit dans #kisso-hq » et
 * « De quoi on a parlé cette semaine ? » partaient donc au DÉFAUT, c'est-à-dire chez
 * l'orchestrateur, qui n'a aucun outil de canal. Conséquence documentée : toute la
 * `disclosure-policy.ts` était du code mort sur la phrase que quelqu'un dirait vraiment — rien
 * ne fuyait, mais ce n'était pas la politique qui l'empêchait, c'était l'inaccessibilité.
 *
 * `résume` avait été écarté de la bande 1 pour cause de fréquence, et à raison. La bande 3 est
 * l'endroit sûr : elle est évaluée SOUS le collant, donc elle ne peut pas détourner une
 * réponse de suivi — et depuis ce jour elle ne prend la main sur un fil vivant que si l'agent
 * qui le mène est STRUCTURELLEMENT incapable de servir la demande (voir `TOPIC_BANDS`).
 *
 * Volontairement absents : `dit` et `parle`, trop courants même ici.
 */
const KNOWLEDGE_TOPICS = ['résume', 'résumé', 'resume', 'resumé'] as const;

/**
 * Un JETON DE CANAL Slack — `<#C0ABC123|general>` — vaut mieux que n'importe quel mot-clé
 * pour désigner une question de canal : il est produit par le client Slack, jamais tapé, et il
 * survit à `cleanText` (qui ne retire que la mention du bot).
 */
// ⚠️ `i` OBLIGATOIRE : le motif est évalué sur le texte MINUSCULÉ (`lowerText`), comme tous
// les autres critères de bande. Sans ce drapeau, `[CG][A-Z0-9]` ne matcherait plus jamais et
// le jeton de canal cesserait d'aiguiller — en silence, aucun type ne bougeant.
// `{2,}` puis un groupe optionnel dont la classe exclut `>` : aucune découpe à essayer.
// Mesuré à 0,07 ms sur 8 000 caractères adverses.
// eslint-disable-next-line security/detect-unsafe-regex
const CHANNEL_TOKEN_PATTERN = /<#[CG][A-Z0-9]{2,}(?:\|[^>]*)?>/i;

/**
 * « QUI PEUT FAIRE QUOI » — la question d'expertise, reconnue par sa FORME INTERROGATIVE.
 *
 * ⚠️ Ajouté le 2026-08-14, **après avoir constaté que `findExpertise` était inatteignable sur
 * ses propres phrases**. Le tool venait d'être écrit et câblé sur `knowledgeAgent` ; or « qui
 * s'occupe du backend ? » ne contient aucun mot-clé de bande 1 ni de bande 3, et retombait
 * donc au défaut, chez un agent qui ne le porte pas. C'est EXACTEMENT le défaut qu'on venait
 * de corriger pour `getChannelHistory` — une capacité livrée sans sa route ne sert à rien, et
 * la campagne de routage l'a rattrapé avant le déploiement.
 *
 * On reconnaît la FORME et non des mots-clés isolés : « qui » seul est bien trop courant, mais
 * « qui » suivi d'un verbe de responsabilité ou de savoir ne désigne qu'une seule chose.
 *
 * Volontairement ABSENT : « qui peut » nu. « Qui peut créer un employé ? » interroge les
 * capacités du BOT, pas l'annuaire des personnes — même critère de discrimination que celui
 * qui a fait écarter « ajoute » et « word ».
 * Les variantes non accentuées sont déclarées : `routeToAgent` minuscule le texte mais ne
 * retire PAS les accents, et une saisie mobile dans Slack les perd.
 */
// ⚠️ L'apostrophe TYPOGRAPHIQUE (`’`, U+2019) est acceptée au même titre que l'ASCII : c'est
// celle que produisent Slack et les claviers mobiles par correction automatique, donc le cas
// FRÉQUENT et non le cas limite. Le premier jet ne connaissait que `'` et « qui s’occupe du
// backend ? » — la phrase de référence — ne matchait pas.
// ⚠️ Bords de mot en `\p{L}` et drapeau `u`, JAMAIS `\b` : sans le drapeau, `\b` raisonne en
// ASCII, donc `à` n'y est pas une lettre et « **à** qui je demande… » ne matchait pas — le
// motif partait silencieusement au défaut. C'est la même correction que celle déjà appliquée à
// `matchesKeyword`, et le même piège, à deux jours d'intervalle.
const APOS = "['’`´]";
const LB = '(?<![\\p{L}])';
const RB = '(?![\\p{L}])';
const EXPERTISE_QUESTION_PATTERN = new RegExp(
  `${LB}qui\\s+(?:s${APOS}?\\s?occupe|g[eè]re|conna[iî]t|sait|ma[iî]trise|travaille|s${APOS}?y\\s+conna[iî]t)${RB}` +
    `|${LB}[aà]\\s+qui\\s+(?:je\\s+)?(?:m${APOS}?\\s?adresser|demandes?|demander|parler)${RB}`,
  'u',
);

/**
 * BANDE 3, sous forme de CAPACITÉS et non plus de simples listes.
 *
 * ── Le défaut corrigé (mesuré le 2026-08-12, non corrigé jusqu'au 2026-08-14) ──
 * Le palier collant a DÉPLACÉ l'état absorbant, il ne l'a pas supprimé. Simulation vérifiée
 * sur les 8 messages d'une campagne type : après « Envoie un rappel à Pamela » (échappement
 * `rappel` → `notificationAgent`), le message « Génère-moi le guide en PDF » restait chez
 * `notificationAgent`, **qui n'a pas `generateDocument`**. En DM la clé de conversation est le
 * CANAL : le verrou tenait donc une heure entière, sur tous les sujets.
 *
 * ── Pourquoi la CAPACITÉ et non la priorité de bande ──
 * Remonter ces termes au-dessus du collant a déjà été essayé, et défait le 2026-08-11 : `pdf`,
 * `email`, `docx` sont massivement des RÉPONSES DE SUIVI (« Donne le PDF alors », « et par
 * email ? »), et les faire primer sur le fil reproduisait l'alternance A → B → A entre agents
 * amnésiques. Les deux mesures sont vraies, et c'est pourquoi la règle ne porte plus sur la
 * priorité mais sur le CÂBLAGE :
 *
 *     le fil est conservé, SAUF si l'agent qui le mène ne porte pas l'outil demandé.
 *
 * Cette forme est sûre dans les deux sens. Elle ne peut jamais arracher un fil à un agent qui
 * sait répondre — donc elle ne peut pas rejouer le défaut du 11 — et elle ne peut jamais
 * laisser un fil chez un agent qui ne sait pas — donc elle ferme celui du 12. Et elle est
 * DÉRIVÉE du câblage (`AGENT_TOOLS`), pas rédigée : un outil déplacé d'un agent à l'autre
 * change le routage tout seul, sans qu'on ait à y penser.
 */
const TOPIC_BANDS: ReadonlyArray<{
  readonly agentId: string;
  readonly keywords: readonly string[];
  /**
   * Motif de FORME, évalué en plus des mots-clés. Il existe parce que deux des trois entrées
   * de knowledge ne se reconnaissent pas à un mot : un jeton de canal `<#C…>` et une question
   * d'expertise (« qui s'occupe de… ») sont des STRUCTURES, pas du vocabulaire.
   */
  readonly pattern?: RegExp;
  /** L'outil SANS LEQUEL la demande est insatisfaisable. C'est lui qui autorise l'écart. */
  readonly requiredTool: string;
  /**
   * Ce terme peut-il déloger un fil vivant quand son agent n'a pas l'outil ?
   *
   * ⚠️ `false` sur la bande notification, et ce n'est PAS une prudence : c'est une
   * correction. Un test de non-régression du 2026-08-11 l'a attrapée — « Par email », après
   * « génère mon document », partait chez `notificationAgent`, ce qui est LE défaut A → B → A
   * que le palier collant existe pour supprimer.
   *
   * La raison de fond : `email` et `message` nomment un TRANSPORT que les deux agents servent
   * légitimement — `generateDocument` porte `deliverTo: 'email'`. L'agent du fil n'est donc
   * jamais « structurellement incapable » de les honorer, et la prémisse de l'écart tombe.
   * `pdf`, `guide` ou `résume`, eux, nomment un ARTEFACT ou une LECTURE qu'un seul agent
   * sait produire.
   *
   * Règle d'admission, à appliquer avant d'en ajouter un : le terme doit désigner une
   * capacité servie par EXACTEMENT UN agent. Dans le doute, `false` — le pire cas est alors
   * l'ancien comportement, pas une régression.
   */
  readonly overridesSticky: boolean;
}> = [
  {
    agentId: 'onboardingOrchestrator',
    keywords: ORCHESTRATOR_TOPICS,
    requiredTool: 'generateDocument',
    overridesSticky: true,
  },
  {
    agentId: 'notificationAgent',
    keywords: NOTIFICATION_TOPICS,
    requiredTool: 'sendNotification',
    overridesSticky: false,
  },
  {
    agentId: 'knowledgeAgent',
    keywords: KNOWLEDGE_TOPICS,
    requiredTool: 'getChannelHistory',
    pattern: CHANNEL_TOKEN_PATTERN,
    overridesSticky: true,
  },
  // « Qui s'occupe du backend ? » — la seule porte d'entrée de `findExpertise`, et il n'en a
  // AUCUNE avant le 2026-08-14 : le tool était câblé mais structurellement inatteignable.
  {
    agentId: 'knowledgeAgent',
    keywords: ['expert', 'spécialiste', 'specialiste', 'compétence', 'competence'],
    requiredTool: 'findExpertise',
    pattern: EXPERTISE_QUESTION_PATTERN,
    overridesSticky: true,
  },
];

/**
 * Mots-clés qui sont des RADICAUX VERBAUX, et tolèrent donc les désinences françaises.
 *
 * Régression corrigée le 2026-08-11 : le bord droit `s?(?![\p{L}])` cassait tous les
 * infinitifs. « Tu peux **retrouver** l'employé dont l'email est X » ne matchait plus la
 * bande 1 et retombait sur `NOTIFICATION_TOPICS` — précisément le bug que cette bande avait
 * été créée pour supprimer, revenu par la conjugaison.
 *
 * La tolérance est déclarée PAR MOT et non globale, et c'est la clé de la correction : les
 * mots-clés NOMINAUX (`rappel`, `message`, `test`) gardent le seul pluriel. L'ouvrir à tous
 * ferait revenir les faux positifs d'origine — « rappelle », « messagerie », « testez ».
 */
const VERB_STEM_KEYWORDS: ReadonlySet<string> = new Set([
  'crée',
  'cree',
  'enregistre',
  'retrouve',
  'recherche',
]);

/** Désinences tolérées sur un radical verbal : pluriel, infinitif, 2ᵉ et 3ᵉ personnes. */
const VERB_SUFFIX_PATTERN = '(?:s|r|z|nt)?';

/**
 * Identifiants d'agents connus. Sert à valider l'agent collant relu en base : une valeur
 * corrompue ou l'identifiant d'un agent retiré du registre ferait sinon lever
 * `mastra.getAgent()` à chaque message du fil, condamnant la conversation entière.
 */
/**
 * Agent porté par les tours mémorisés qui ne viennent d'AUCUN agent — aujourd'hui la seule
 * réponse déterministe du système, celle aux salutations nues. On l'attribue au routage par
 * défaut plutôt qu'à une valeur sentinelle : `conversation_turns.agent_id` sert à préfixer
 * « [autre agent] » dans l'historique rejoué, et une valeur inconnue de `KNOWN_AGENT_IDS`
 * ferait marquer ce tour comme étranger à chaque message suivant du fil.
 */
export const DEFAULT_AGENT_ID = 'onboardingOrchestrator';

/**
 * ⚠️ `questionnaireEngine` en est SORTI le 2026-08-14, et cette sortie a deux effets voulus.
 *
 *  1. Le palier COLLANT l'ignore. Sans cela, un fil ouvert avant le retrait aurait continué
 *     de pointer un agent absent du registre — et `mastra.getAgent()` LÈVE dans ce cas
 *     (`MASTRA_GET_AGENT_BY_NAME_NOT_FOUND`), donc le fil aurait été condamné jusqu'au TTL.
 *  2. Les tours `assistant` qu'il a écrits sont désormais préfixés « [autre agent] » dans
 *     l'historique rejoué. C'est LITTÉRALEMENT vrai : cet assistant n'existe plus, et ses
 *     promesses de questionnaire ne doivent pas être reprises à son compte.
 */
const KNOWN_AGENT_IDS: ReadonlySet<string> = new Set([
  'onboardingOrchestrator',
  'notificationAgent',
  'knowledgeAgent',
  'recruitmentAgent',
]);

/**
 * Un mot-clé matche s'il apparaît dans le texte, bordé des DEUX côtés par autre chose
 * qu'une lettre.
 *
 * La garde ne portait au départ que sur le bord GAUCHE : `String.includes('test')` matchait
 * aussi « conteste », « attester », « protestation » — des phrases françaises courantes sans
 * rapport. Le bord droit a écarté « rappelle », « messagerie », « testez », mais il a cassé
 * TOUS les infinitifs (« tu peux retrouver l'employé dont l'email est X » retombait sur
 * `NOTIFICATION_TOPICS`, soit le retour du bug du 2026-08-10 par la conjugaison). D'où le
 * suffixe déclaré MOT PAR MOT : radicaux verbaux tolérants, mots-clés nominaux au seul
 * pluriel. L'ouvrir à tous ferait revenir les faux positifs d'origine.
 *
 * ⚠️ `\p{L}` avec le drapeau `u`, jamais `\b` : sans `u`, `\b` raisonne en ASCII et un motif
 * comme `/\bbloqué\b/` ne matche JAMAIS. Piège rencontré trois fois dans ce dépôt.
 */
export function matchesKeyword(lowerText: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = VERB_STEM_KEYWORDS.has(keyword) ? VERB_SUFFIX_PATTERN : 's?';
  // `escaped` sort de la ligne ci-dessus, et `keyword` vient des tables de ce module :
  // jamais d'un utilisateur.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const pattern = new RegExp(`(?<![\\p{L}])${escaped}${suffix}(?![\\p{L}])`, 'u');
  return pattern.test(lowerText);
}

/**
 * Routage message → agent, en QUATRE TEMPS. Les listes sont CONTRACTUELLES (documentées
 * dans `CLAUDE.md`) : les modifier sans mettre la doc à jour la fait mentir.
 *
 *  1. ÉCHAPPEMENT — `ESCAPE_INTENTS`, symétrique : chaque agent y a ses termes, donc aucun
 *     n'est un état absorbant. C'est la seule porte de sortie d'un fil mal aiguillé.
 *  2. COLLANT — l'agent qui mène le fil.
 *  3. THÉMATIQUE — exprimé en CAPACITÉS (`TOPIC_BANDS`), et il ne déloge le fil qu'à une
 *     condition : l'agent qui le mène ne porte pas l'outil exigé.
 *  4. Défaut — l'orchestrateur.
 *
 * ## Pourquoi la bande 3 est CALCULÉE avant d'appliquer le collant
 *
 * Parce que la décision du palier 2 en dépend : le fil ne cède que si son agent est
 * structurellement incapable de servir la demande, il faut donc savoir quelle capacité la
 * demande exige avant de décider si on reste. La règle est sûre dans les deux sens — elle ne
 * peut jamais arracher un fil à un agent qui sait répondre (défaut du 2026-08-11), ni le
 * laisser chez un agent qui ne sait pas (défaut du 2026-08-12). Et elle est DÉRIVÉE
 * d'`AGENT_TOOLS` : déplacer un outil d'un agent à l'autre change le routage tout seul.
 */
export function routeToAgent(text: string, stickyAgentId?: string): string {
  const lowerText = (text ?? '').toLowerCase();
  const matchesAny = (keywords: readonly string[]): boolean =>
    keywords.some((keyword) => matchesKeyword(lowerText, keyword));

  // 1. ÉCHAPPEMENT. Prime sur le fil en cours : une demande explicite doit pouvoir SORTIR
  // d'une conversation collée sur le mauvais agent, sinon le fil est un piège sans issue.
  // L'ordre du tableau EST la priorité entre agents.
  for (const [agentId, keywords] of ESCAPE_INTENTS) {
    if (matchesAny(keywords)) return agentId;
  }

  // 3. THÉMATIQUE, calculée d'abord — voir l'en-tête.
  const topic = TOPIC_BANDS.find(
    (band) => matchesAny(band.keywords) || (band.pattern?.test(lowerText) ?? false),
  );

  // 2. COLLANT. Correction du défaut central mesuré le 2026-08-11 : le routage était
  // recalculé sur le texte de CHAQUE message, isolément. « Par email » répondait à une
  // question posée par l'orchestrateur et arrivait chez un agent qui ne l'avait jamais
  // posée — d'où le « Quel est l'objet de cette notification ? », qui est littéralement le
  // schéma d'entrée de `sendNotification` redemandé à zéro.
  //
  // Un identifiant inconnu du registre est IGNORÉ : le suivre aveuglément ferait lever
  // `getAgent` à chaque message et condamnerait le fil entier.
  if (stickyAgentId && KNOWN_AGENT_IDS.has(stickyAgentId)) {
    const stickyCannotServe =
      topic !== undefined &&
      topic.overridesSticky &&
      !agentHasTool(stickyAgentId, topic.requiredTool);
    if (!stickyCannotServe) return stickyAgentId;
  }

  if (topic) return topic.agentId;

  // 4. Défaut.
  return DEFAULT_AGENT_ID;
}
