/**
 * Reconnaissance d'une DEMANDE D'EFFACEMENT — court-circuit déterministe, zéro appel LLM.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le défaut : il n'existait AUCUN chemin d'effacement, nulle part
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `ConversationRepository` exposait `append`, `recentTurns` et `prune` — et rien qui
 * réponde à une personne. « oublie ce que je t'ai dit » et « supprime tout ce que tu sais
 * de moi » partaient donc au modèle, qui n'a aucun outil d'effacement et ne peut faire
 * qu'une chose : le raconter. C'est exactement le défaut central de ce dépôt, formulé par
 * l'utilisatrice testeuse — « il parle exactement de la même façon quand il a fait le
 * travail et quand il l'a inventé » — appliqué cette fois à une demande à laquelle on ne
 * peut PAS répondre par une narration.
 *
 * Ici la réconciliation FAIT/NARRATION du handler n'aurait rien rattrapé : elle guette une
 * formule d'accompli sans `toolCall`, or il n'existe aucun tool à appeler, donc aucune
 * contradiction à constater. Le seul correctif possible est de RENDRE LE GESTE RÉEL.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le critère : INTERSECTION — ni l'égalité de `greeting`, ni l'inclusion de `distress`
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Les deux autres court-circuits penchent d'un côté assumé : `greeting` exige une égalité
 * stricte parce qu'un faux positif ferait cesser de réfléchir sur une vraie demande ;
 * `distress` se contente d'une inclusion parce qu'un faux négatif laisse quelqu'un sans
 * réponse. Ici la dissymétrie est encore plus forte, et dans l'autre sens : **un faux
 * positif DÉTRUIT des données, et rien ne les rétablit.**
 *
 * D'où une condition à TROIS termes, tous obligatoires :
 *   1. un VERBE d'effacement (`oublie`, `supprime`, `efface`…) ;
 *   2. ce verbe doit être un ORDRE — premier mot du message (impératif), ou précédé d'une
 *      formule de demande explicite (`peux-tu`, `merci de`, `je veux que tu`) ;
 *   3. un OBJET qui désigne sans ambiguïté la mémoire ou les données (`ce que je t'ai
 *      dit`, `ce que tu sais de moi`, `notre conversation`, `mes données`…).
 *
 * ⚠️ **Le terme 2 a été ajouté après une revue adversariale qui a REPRODUIT la perte de
 * données.** La première version ne demandait que le verbe et l'objet, plus une garde de
 * négation qui n'examinait que les caractères IMMÉDIATEMENT collés au verbe. Six phrases
 * françaises ordinaires effaçaient donc réellement la mémoire de quelqu'un, dont celle-ci,
 * qui demande exactement le CONTRAIRE :
 *
 *     « Je ne veux surtout pas que tu oublies ce que je t'ai dit »
 *
 * — la négation `pas` y est séparée du verbe par `que tu`, donc invisible pour une garde
 * d'adjacence. Et ces trois-là, qui ne demandent rien du tout :
 *
 *     « Est-ce que tu vas oublier ce que je t'ai dit si je change d'avis ? »
 *     « Pourquoi as-tu oublié ce que je t'ai dit hier ? »
 *     « Tu risques d'oublier ce que je t'ai dit, non ? »
 *
 * La leçon n'est pas qu'il manquait des motifs : c'est qu'on cherchait la PRÉSENCE d'un
 * verbe là où il fallait chercher un ACTE DE LANGAGE. Une question, un reproche et un
 * pronostic contiennent tous le même verbe qu'un ordre. Le raisonnement par mots présents
 * ne peut pas les distinguer ; la position du verbe, si.
 *
 * Aucun des trois termes ne suffit seul, et c'est ce qui rend le module sûr :
 *
 *  - **« oublie ça » n'est PAS capturé**, et c'est la décision la plus importante du
 *    fichier. C'est une correction conversationnelle (« non, ignore ça »), pas une demande
 *    d'effacement : le sens de la phrase porte sur le dernier échange, pas sur la mémoire.
 *    L'intercepter effacerait un fil entier parce que quelqu'un s'est repris.
 *  - **« n'oublie pas de… » n'est PAS capturé** non plus : le verbe y est, l'objet n'y est
 *    pas, et la garde de négation ci-dessous l'écarte deux fois plutôt qu'une.
 *  - « supprime le compte de Awa » n'est pas capturé : l'objet désigne un tiers, pas la
 *    mémoire. Cette demande-là doit atteindre un agent, qui répondra qu'il ne sait pas le
 *    faire — c'est une frontière de capacité, pas une opération sur les données.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi du code, et non un outil exposé au modèle
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Un `forgetMe` exposé aux agents aurait trois défauts, chacun rédhibitoire : il coûterait
 * son schéma à chaque aller-retour de chaque message sous un budget de ≈ 19 messages/jour ;
 * il resterait PROBABILISTE, alors qu'un effacement doit être garanti ; et il donnerait à un
 * modèle — dont l'entrée est un texte écrit par un humain arbitraire — le pouvoir de
 * supprimer les données de quelqu'un. Le geste est déterministe, donc il est en code.
 */

import { normalizeIntentText } from './intent-text';

/**
 * Normalisation commune : minuscules, accents retirés, ponctuation réduite à l'espace.
 *
 * Même forme que `greeting.ts` — décomposition NFD puis liste blanche `[a-z0-9 ]`, jamais
 * une liste noire. L'apostrophe devient une espace, donc « ce que je t'ai dit » et
 * « ce que je t ai dit » se normalisent pareillement : c'est voulu, la ponctuation de
 * quelqu'un qui écrit vite ne doit pas décider si ses données sont effacées.
 */

/**
 * Radicaux des verbes d'effacement, sous forme normalisée.
 *
 * Comparés en PRÉFIXE DE MOT et non en sous-chaîne : la tokenisation par espaces rend le
 * bord droit gratuit (`oublier`, `oublies`, `oubliez` commencent tous par `oubli`) et le
 * bord gauche garanti — une sous-chaîne aurait fait matcher n'importe quel mot les
 * contenant, ce qui est l'erreur que le routage a déjà payée avec `test` dans `conteste`.
 */
const ERASURE_STEMS: readonly string[] = [
  'oubli', // oublie, oublier, oubliez, oublies, oublié
  'supprim', // supprime, supprimer, supprimez
  'efface', // efface, effacer, effacez
  'delete', // le workspace est francophone, mais ces deux-là coûtent zéro
  'forget',
];

/**
 * Formules qui font d'un verbe un ORDRE alors qu'il n'ouvre pas le message.
 *
 * Liste FERMÉE et courte, cherchée dans les 3 mots qui PRÉCÈDENT le verbe. C'est la
 * différence entre « peux-tu effacer nos échanges ? » (une demande) et « vas-tu oublier ce
 * que je t'ai dit ? » (une question sur l'avenir) — deux interrogatives, un seul ordre.
 */
const REQUEST_MARKERS: readonly string[] = [
  'peux tu',
  'tu peux',
  'pourrais tu',
  'tu pourrais',
  'merci de',
  // Formules VOLONTAIREMENT courtes — deux mots au plus. La fenêtre de recherche ne fait que
  // trois mots, donc « je veux que tu » n'y tiendrait jamais : le sujet est déjà sorti du
  // cadre quand on atteint le verbe. Le risque d'élargissement est nul ici, la négation
  // étant contrôlée séparément et sur une fenêtre plus large (« je ne veux PAS que tu… »).
  'veux que',
  'aimerais que',
  'faut que',
  'please',
];

/** Nombre de mots examinés avant le verbe pour y chercher une formule de demande. */
const REQUEST_LOOKBACK_WORDS = 3;

/**
 * Nombre de mots examinés DE PART ET D'AUTRE du verbe pour y chercher une négation.
 *
 * Quatre, et pas moins : c'est ce qu'il faut pour voir le `pas` de « ne veux surtout **pas**
 * que tu oublies », séparé du verbe par deux mots. C'est précisément la phrase sur laquelle
 * la revue adversariale a reproduit une perte de données réelle.
 *
 * Des DEUX côtés, parce que le français place la négation avant ou après selon la forme :
 * « **ne** supprime **pas** » et l'oral « oublie **pas** ce que je t'ai dit ».
 */
const NEGATION_WINDOW_WORDS = 4;

/**
 * Objets qui désignent la mémoire ou les données de la PERSONNE QUI PARLE.
 *
 * Critère d'admission, strict : l'expression doit être incapable de désigner autre chose
 * que ce que le bot a retenu de cet échange. « tout » seul en est exclu (« supprime tout »
 * peut viser un dossier, une liste de tâches, n'importe quoi) ; « tout ce que je t'ai dit »
 * y entre, parce qu'il ne peut rien viser d'autre.
 */
const MEMORY_OBJECTS: readonly string[] = [
  'ce que je t ai dit',
  'ce que je tai dit',
  'ce que je viens de dire',
  'ce que tu sais de moi',
  'ce que tu sais sur moi',
  'ce que tu as retenu',
  'ce que tu as memorise',
  'ce que je t ai raconte',
  'mes donnees',
  'mes informations',
  'mes messages',
  // ⚠️ « la conversation » nu est DÉLIBÉRÉMENT absent, retiré après revue : il désigne aussi
  // bien la nôtre que celle d'un tiers (« supprime la conversation d'Awa avec les RH »), et
  // l'ambiguïté se paierait par la destruction de la mauvaise. Les déterminants possessifs
  // et démonstratifs, eux, ne peuvent désigner que l'échange en cours.
  'notre conversation',
  'nos conversations',
  'nos echanges',
  'cette conversation',
  'ta memoire',
  'ton historique',
  'l historique de notre',
  'my data',
  'everything i told you',
  'this conversation',
];

/**
 * Négations qui INVERSENT la demande.
 *
 * « n'oublie pas de relancer Awa » contient le verbe et pourrait, sur une formulation
 * malheureuse, contenir aussi un objet. La garde est donc explicite plutôt que déduite :
 * on cherche la négation dans les quelques caractères qui PRÉCÈDENT le verbe, parce que
 * c'est là qu'elle vit en français.
 */
const NEGATIONS: ReadonlySet<string> = new Set([
  'ne',
  'n',
  'pas',
  'sans',
  'jamais',
  'aucun',
  'aucune',
  'rien',
  'surtout', // « surtout pas » — le second mot suffit, mais le premier ne coûte rien
  'never',
  'dont',
]);

/**
 * Borne de longueur. Une demande d'effacement est courte et directe. Au-delà, le texte
 * contient forcément autre chose, et cet autre chose mérite une vraie réponse — pas une
 * suppression déclenchée par une sous-chaîne noyée dans un paragraphe.
 */
const MAX_ERASURE_LENGTH = 200;

/**
 * Ce verbe-ci est-il nié ?
 *
 * Regarde une FENÊTRE DE MOTS de part et d'autre, et non les caractères collés au verbe.
 * C'est le correctif de la revue adversariale : « ne veux surtout **pas** que tu oublies »
 * plaçait la négation à deux mots du verbe, donc hors de portée d'une garde d'adjacence —
 * et cette phrase, qui demande de GARDER la mémoire, l'effaçait.
 */
function isNegated(words: readonly string[], verbIndex: number): boolean {
  const from = Math.max(0, verbIndex - NEGATION_WINDOW_WORDS);
  const to = Math.min(words.length, verbIndex + NEGATION_WINDOW_WORDS + 1);

  for (let i = from; i < to; i += 1) {
    if (i !== verbIndex && NEGATIONS.has(words[i])) return true;
  }

  return false;
}

/**
 * Ce verbe-ci est-il employé comme un ORDRE ?
 *
 * Deux formes seulement, et c'est volontairement peu :
 *  - **il ouvre le message** — c'est l'impératif français (« oublie… », « supprime… ») ;
 *  - **il est précédé d'une formule de demande** (« peux-tu effacer… », « merci de
 *    supprimer… »).
 *
 * Tout le reste est écarté, et c'est le point : « vas-tu oublier… ? », « pourquoi as-tu
 * oublié… ? », « tu risques d'oublier… » contiennent le MÊME VERBE et le MÊME OBJET qu'un
 * ordre. Aucune liste de mots ne peut les en distinguer — seule la position le peut.
 */
function isAnOrder(words: readonly string[], verbIndex: number): boolean {
  if (verbIndex === 0) return true;

  const before = words.slice(Math.max(0, verbIndex - REQUEST_LOOKBACK_WORDS), verbIndex).join(' ');
  return REQUEST_MARKERS.some((marker) => before.includes(marker));
}

/** Ce mot commence-t-il par un radical d'effacement ? */
function isErasureVerb(word: string): boolean {
  return ERASURE_STEMS.some((stem) => word.startsWith(stem));
}

/**
 * Le message ORDONNE-t-il explicitement l'effacement de ce que le bot a retenu ?
 *
 * Les trois termes de l'en-tête, dans l'ordre le moins coûteux : l'objet d'abord (une
 * recherche de sous-chaîne écarte l'immense majorité des messages), puis, seulement pour
 * ceux qui restent, l'analyse de position du verbe.
 */
export function requestsErasure(text: string | undefined | null): boolean {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_ERASURE_LENGTH) return false;

  const normalized = normalizeIntentText(raw);

  if (!MEMORY_OBJECTS.some((object) => normalized.includes(object))) return false;

  const words = normalized.split(' ');

  // Toutes les occurrences, pas seulement la première : un message peut narrer un oubli
  // avant de demander un effacement. Il suffit qu'UNE seule soit un ordre non nié.
  return words.some(
    (word, index) => isErasureVerb(word) && isAnOrder(words, index) && !isNegated(words, index),
  );
}

/**
 * Ce que l'effacement NE couvre PAS — et pourquoi cette phrase est la moitié du correctif.
 *
 * Effacer la mémoire conversationnelle puis répondre « c'est fait » laisserait croire que
 * plus rien ne subsiste, alors que les notifications envoyées, les documents produits,
 * l'annuaire et le journal d'audit sont intacts. Ce serait la même faute que
 * `emailSent: false` sous `status: 'success'` : une affirmation vraie dans sa lettre et
 * fausse dans ce qu'elle laisse comprendre. On nomme donc la frontière dans la réponse.
 */
export const ERASURE_SCOPE_NOTICE =
  'Ça ne touche que ce que je garde de nos échanges. Les documents déjà produits, les ' +
  "notifications déjà envoyées et ta fiche dans l'annuaire ne passent pas par moi — " +
  "pour ceux-là, adresse-toi à l'équipe RH.";

/** Effacement réussi. `count` est le nombre de tours réellement supprimés. */
export function erasureDoneReply(count: number): string {
  if (count === 0) {
    return `Je n'avais rien retenu de nos échanges. ${ERASURE_SCOPE_NOTICE}`;
  }

  // L'accord était écrit en quatre ternaires imbriqués dans une seule interpolation, ce qui
  // rendait la phrase illisible pour la seule chose qui compte ici : ce qu'elle DIT. Le
  // pluriel se décide une fois.
  const plural = count > 1;
  const s = plural ? 's' : '';
  const verb = plural ? 'ont' : 'a';

  return (
    `C'est effacé : ${count} message${s} que j'avais gardé${s} de nos échanges ` +
    `${verb} été supprimé${s}. ${ERASURE_SCOPE_NOTICE}`
  );
}

/**
 * Effacement IMPOSSIBLE — la mémoire est indisponible.
 *
 * ⚠️ Ne jamais rendre `erasureDoneReply` dans ce cas. Toute la valeur du correctif tient
 * dans le fait que la réponse dit ce qui s'est réellement passé ; annoncer une suppression
 * qui n'a pas eu lieu serait pire que l'absence de fonctionnalité, parce que la personne
 * cesserait de demander.
 */
export const ERASURE_FAILED_REPLY =
  "Je n'ai pas réussi à effacer ce que j'avais gardé de nos échanges — ma mémoire est " +
  "indisponible à l'instant. Redemande-le-moi dans un moment, ou signale-le à l'équipe RH.";
