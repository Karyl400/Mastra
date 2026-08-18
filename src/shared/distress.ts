/**
 * Reconnaissance d'une DÉTRESSE — court-circuit déterministe, zéro appel LLM.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi ce module existe
 * ════════════════════════════════════════════════════════════════════════════
 *
 * C'est le seul endroit de ce dépôt où un défaut peut nuire à une PERSONNE, et non au
 * produit. Audit du 2026-08-13 : « je suis harcelé par mon manager » ou « je ne vais pas
 * bien du tout » ne déclenchait rien du tout — aucun motif de `INJECTION_PATTERNS`, aucun
 * court-circuit, aucune ligne dans les instructions des quatre agents. Le message partait
 * chez `onboardingOrchestrator` par le palier PAR DÉFAUT, avec un bloc STYLE qui impose
 * « collègue, ton neutre, phrases courtes, sans exclamation » — le registre le plus inadapté
 * qui soit — et une chance réelle de déclencher un outil parasite : « Bonjour », sept
 * caractères, avait produit quatre appels dont une ÉCRITURE (`updateOnboardingStatus`).
 *
 * Le dépôt savait pourtant à quoi sert ce canal. `slack-events.handler.ts` l'écrit noir sur
 * blanc pour justifier de ne pas journaliser le texte : « le DM au bot est le canal
 * privilégié pour parler d'un salaire, d'un arrêt maladie ou d'un litige ». Il en avait tiré
 * une règle de journalisation, et aucune règle de RÉPONSE.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi du code et non une consigne de prompt
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Même argument que `greeting.ts`, et il pèse plus lourd ici : une consigne serait payée à
 * chaque aller-retour de chaque message sous un quota de ≈ 19 messages/jour, resterait
 * PROBABILISTE, et échouerait précisément quand le fournisseur est saturé — c'est-à-dire au
 * moment où la personne reçoit « Je suis à court de quota ». Ici le coût est nul et la
 * garantie totale : aucun modèle n'est appelé, donc aucun modèle ne peut se tromper.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le critère : INCLUSION, et non égalité — l'inverse de `greeting.ts`
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `isBareGreeting` exige une égalité stricte parce qu'une vraie demande commence souvent par
 * « bonjour ». Ici c'est l'inverse : une détresse est presque toujours NOYÉE dans une phrase
 * (« je t'écris parce que je ne vais pas bien »), et la manquer coûte infiniment plus cher
 * qu'un faux positif. Un faux positif donne à quelqu'un un message bienveillant qu'il n'avait
 * pas demandé ; un faux négatif laisse un modèle de RH répondre par un ton neutre à une
 * personne qui va mal.
 *
 * Les tournures sont donc DÉLIBÉRÉMENT peu nombreuses et sans ambiguïté. Ce n'est pas un
 * classificateur : c'est un filet pour les formulations les plus directes, celles où se
 * tromper n'est pas permis.
 *
 * ⚠️ Ce module ne prétend PAS détecter la détresse. Il attrape ce qui est dit explicitement.
 * Tout le reste passe au chemin normal, comme avant.
 */

/**
 * Tournures interceptées, sous forme NORMALISÉE (minuscules, sans accent).
 *
 * Chaque entrée est une SOUS-CHAÎNE cherchée dans le message. Elles sont choisies pour ne
 * pas apparaître dans une demande d'onboarding ordinaire — c'est le seul critère
 * d'admission, et il est plus strict qu'il n'y paraît : « mal » seul, ou « aide », ont été
 * écartés pour cette raison exacte.
 */
const DISTRESS_PHRASES: readonly string[] = [
  // Atteinte à soi
  'je veux mourir',
  'je veux meurir',
  'envie de mourir',
  'envie d en finir',
  'en finir avec la vie',
  'me suicider',
  'suicide',
  'me faire du mal',
  'idees noires',
  'plus envie de vivre',
  'a quoi bon vivre',

  // Détresse déclarée
  'je ne vais pas bien',
  'je vais tres mal',
  'je vais pas bien',
  'je craque',
  'je suis a bout',
  'burn out',
  'burnout',
  'depression',
  'je suis deprime',

  // Harcèlement et violence subis
  'harcele',
  'harcelement',
  'harcelement moral',
  'harcelement sexuel',
  'je suis agresse',
  'agression sexuelle',
  // « me menace » sans sujet : énumérer les sujets (`on`, `il`, `elle`) laissait passer
  // « mon responsable me menace », qui est exactement le cas visé. Le complément suffit à
  // lever l'ambiguïté — c'est la personne qui parle qui est menacée, quel que soit l'auteur.
  'me menace',
  'me harcele',
  'discrimination',
  'je suis discrimine',
];

/** Borne haute : au-delà, c'est un document collé, pas une confidence. */
const MAX_DISTRESS_LENGTH = 2000;

/**
 * Normalise pour comparaison : minuscules, accents retirés, ponctuation réduite à des
 * espaces.
 *
 * Même méthode que `greeting.ts` — décomposition NFD puis retrait des marques combinantes
 * SANS rien mettre à la place, sinon « harcelé » deviendrait « harcel e ».
 */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .toLowerCase()
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Le message exprime-t-il explicitement une détresse ou un harcèlement subi ? */
export function detectsDistress(text: string | undefined | null): boolean {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_DISTRESS_LENGTH) return false;

  const normalized = normalize(raw);
  return DISTRESS_PHRASES.some((phrase) => normalized.includes(phrase));
}

/**
 * Réponse rendue. Elle est écrite ici, en dur, et jamais produite par un modèle.
 *
 * Trois choix, chacun assumé :
 *
 *  1. **Elle NOMME un humain à joindre.** `NEUTRAL_REFUSAL` a été délibérément réécrit pour
 *     ne renvoyer vers personne — décision juste pour un refus de sécurité (le bot ne sait
 *     pas à qui il parle), mais elle avait supprimé le dernier endroit du système qui
 *     mentionnait un être humain. Ici, ne renvoyer vers personne serait une faute.
 *
 *  2. **Elle ne diagnostique rien et ne conseille rien.** Ce bot n'a ni la compétence ni le
 *     mandat. Il constate, il oriente, il s'efface.
 *
 *  3. **Elle rompt le registre « collègue, ton neutre » du bloc STYLE**, et c'est le but :
 *     ce registre est précisément ce qui rendait la réponse inadaptée.
 *
 * ⚠️ **LE NUMÉRO A ÉTÉ CORRIGÉ LE 2026-08-18, et c'était un défaut de JOIGNABILITÉ, pas de
 * ton.** Ce message citait le **3114**, numéro national **français**. Les salariés de Kisso
 * sont au **Nigeria** (confirmé par le propriétaire ; le fuseau par défaut du produit,
 * `Africa/Lagos`, le laissait déjà entendre). Le numéro le plus important de tout ce dépôt
 * ne joignait donc personne — et il était présenté comme joignable.
 *
 * C'est la même famille de défaut que tout ce que ce dépôt traque, appliquée au pire endroit
 * possible : une ressource annoncée qui n'existe pas pour son destinataire.
 *
 * Les numéros retenus, vérifiés le 2026-08-18 auprès de *LifeLine International*, fédération
 * internationale dont **SURPIN** est le membre nigérian
 * (`lifeline-international.com/member/nigeria-surpin/`) :
 *   • **0800 0787 746** — SURPIN, gratuit, 24 h/24, présent dans les 36 États et le FCT ;
 *   • **112** — urgences nationales, quand la vie est en jeu à l'instant même.
 *
 * ⚠️ **Ne JAMAIS écrire ici un numéro non vérifié.** Un numéro faux dans ce message est pire
 * que l'absence de numéro : il consomme le seul geste que la personne aura peut-être la force
 * de faire. En cas de doute sur une ligne, on retire la ligne, on ne l'approxime pas.
 *
 * Ils restent écrits en dur plutôt que configurés : une valeur configurable est une valeur
 * qui peut être vide, et ce message-ci ne doit jamais l'être.
 */
export const DISTRESS_REPLY =
  "Je suis un outil d'onboarding, je ne suis pas la bonne personne pour ça — mais je ne vais " +
  'pas te laisser sans réponse.\n\n' +
  "Si c'est urgent : **0800 0787 746** (SURPIN, gratuit, 24h/24, partout au Nigeria), ou le " +
  '**112** si la vie de quelqu’un est en jeu maintenant.\n' +
  "Pour une situation au travail — harcèlement, conflit, souffrance — parles-en à l'équipe RH " +
  "de Kisso ou à la médecine du travail. Tu peux aussi en parler à quelqu'un en qui tu as " +
  'confiance dans le workspace.\n\n' +
  "Je n'ai pas transmis ce message : il reste entre nous.";
