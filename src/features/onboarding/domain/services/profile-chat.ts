/**
 * Compléter son dossier EN CONVERSATION — la dernière modale du produit disparaît.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi, et pourquoi c'était inévitable
 * ════════════════════════════════════════════════════════════════════════════
 *
 * « Compléter mon profil » ouvrait une modale, donc dépendait d'un `trigger_id` Slack, qui
 * expire **3 secondes** après le clic. Mesuré le 2026-08-19 en production, sur un clic signé :
 * l'ACK mettait 5 229 ms à froid et 9 173 ms sur un déploiement neuf — le budget était épuisé
 * avant la première instruction.
 *
 * Le portier d'ACK (`scripts/slack-ack-function/`) a ramené cet ACK sous la seconde, mais il
 * ne peut PAS sauver une modale : il répond vite parce qu'il ne connaît rien du produit, et
 * l'ouverture de la fenêtre a lieu ensuite, dans la fonction applicative, qui reste froide.
 * Vérifié dans les journaux : `Unable to open the profile modal … invalid_trigger_id`.
 *
 * Aucune optimisation ne rattrape cela. Une modale suppose qu'un serveur réponde en moins de
 * 3 s à un instant qu'on ne choisit pas ; ce déploiement ne peut pas le garantir. La modale
 * de l'entretien avait déjà été retirée pour cette raison exacte le 2026-08-19 — celle du
 * profil était la dernière.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * La conception, identique à celle de l'entretien
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ZÉRO appel de modèle : les questions sont des constantes, la validation est du code. Sur un
 * budget de ≈ 19 messages par JOUR pour tout le workspace, faire poser par un LLM des
 * questions dont le texte est connu d'avance coûterait un quart de la journée pour remplir
 * quatre champs.
 *
 * ⚠️ L'état n'est stocké NULLE PART. Il se reconstitue à partir du fil, que le handler charge
 * déjà pour la mémoire conversationnelle : chaque question posée par le bot est suivie de la
 * réponse de la personne, donc `collectProfileAnswers` n'a qu'à apparier les tours. Aucune
 * table, aucune colonne, aucune lecture de plus sur le chemin des 3 secondes.
 *
 * Conséquence assumée, la même que pour l'entretien : l'historique est borné par
 * `CONVERSATION_TTL_MS` (60 min). Un dossier laissé en plan une heure repart de « C'est
 * fait ». C'est un abandon silencieux, jamais un mensonge — rien n'a été promis entre-temps.
 */

/** Les champs qu'un dossier exploitable doit porter, dans l'ordre où on les demande. */
export type ProfileStep = 'firstName' | 'lastName' | 'email' | 'position';

export const PROFILE_STEP_ORDER: readonly ProfileStep[] = [
  'firstName',
  'lastName',
  'email',
  'position',
];

/**
 * ⚠️ CE SONT DES CONSTANTES, et c'est ce qui fait tenir la machine à états : l'étape en cours
 * se reconnaît en comparant le dernier tour du bot à ces chaînes. Les reformuler ailleurs
 * casserait la reconnaissance en silence — aucun type ne bougerait, aucun test de ces
 * constantes ne rougirait.
 *
 * ⚠️ mrkdwn Slack (`*gras*`), jamais markdown GitHub : ces textes sont postés en dur et ne
 * passent par AUCUN filtre. `sanitizeAgentOutput` n'a qu'un seul site d'appel — la réponse
 * d'un modèle.
 */
export const PROFILE_QUESTIONS: Readonly<Record<ProfileStep, string>> = {
  firstName: 'Commençons par le plus simple : quel est ton *prénom* ?',
  lastName: 'Et ton *nom de famille* ?',
  email: 'Quelle est ton *adresse email professionnelle* ?',
  position: 'Dernière chose : *l’intitulé de ton poste* ? Par exemple « Backend Developer ».',
};

/** Ce que la personne a déjà donné, quelle qu'en soit la source. */
export type ProfileAnswers = Partial<Record<ProfileStep, string>>;

/** Un tour de conversation, réduit à ce dont cette machine a besoin. */
export interface ProfileTurn {
  readonly role: string;
  readonly content: string;
}

const MAX_ANSWER_CHARS: Readonly<Record<ProfileStep, number>> = {
  firstName: 60,
  lastName: 60,
  email: 120,
  position: 80,
};

/**
 * Reconnaît une ADRESSE plutôt qu'une phrase — volontairement permissif, et sans expression
 * régulière.
 *
 * ⚠️ Deux raisons, dans cet ordre. D'abord la correction : une validation stricte rejette des
 * adresses valides (sous-domaines, `+`, TLD longs) et le symptôme, pour la personne, est « le
 * bot refuse mon adresse » sans qu'elle sache pourquoi. Ce qu'on doit attraper ici, c'est une
 * phrase à la place d'une adresse, pas une RFC — l'adresse est la clé de résolution du
 * dossier, une faute de frappe se voit au tour suivant.
 *
 * Ensuite le coût : le motif naturel (`[^\s@]+@[^\s@]+\.[^\s@]{2,}`) est à performance
 * super-linéaire par retour arrière, et ce dépôt a déjà mesuré des ReDoS réels sur ses portes
 * d'entrée. Un découpage explicite est linéaire par construction, et se lit mieux.
 */
function looksLikeEmail(value: string): boolean {
  if (/\s/u.test(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && domain.length - dot > 2;
}

/**
 * ⚠️ Reconnaît un REFUS, pas des mots-clés. Même garde que `captureInterviewAnswer` : sans
 * elle, « je n'ai pas d'adresse pro » deviendrait l'adresse professionnelle de la personne,
 * et ce champ est la clé de résolution de son dossier.
 *
 * Ancré au DÉBUT du message : « je termine les tickets » est une réponse valable au poste.
 */
/**
 * ⚠️ ESPACES LITTÉRAUX, jamais `\s+` : `captureProfileAnswer` a déjà normalisé les blancs
 * avant d'appeler ces motifs. Écrire `\s+` ici rouvrirait un retour arrière quadratique pour
 * zéro gain — et ce dépôt a mesuré de vrais ReDoS sur ses portes d'entrée le 2026-08-18.
 */
const REFUSAL_PATTERNS: readonly RegExp[] = [
  /^je (?:ne |n['’])?(?:sais|ai) pas\b/iu,
  /^(?:aucun|aucune|rien)\b/iu,
  /^c['’]est\s+quoi\b/iu,
];

function isRefusal(value: string): boolean {
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Quelle question le bot vient-il de poser ?
 *
 * ⚠️ `includes` et non `startsWith` — défaut mesuré en production le 2026-08-19 sur la machine
 * jumelle : le handler accole des notes en fin de réponse (accompli requalifié, couverture
 * d'extraits), et le texte qui pose une question peut être précédé d'une phrase de contexte.
 * `includes` est le seul critère qui survive aux deux.
 *
 * ⚠️ L'ordre de balayage est celui des étapes INVERSÉ : la question la plus avancée l'emporte
 * si un texte venait à en citer deux, sinon la machine bouclerait sur sa première étape.
 */
export function pendingProfileStep(lastAssistantText: string | undefined): ProfileStep | null {
  const text = (lastAssistantText ?? '').trim();
  if (!text) return null;
  for (const step of [...PROFILE_STEP_ORDER].reverse()) {
    if (text.includes(PROFILE_QUESTIONS[step])) return step;
  }
  return null;
}

/**
 * La réponse est-elle exploitable ? Rend la valeur retenue, ou `null` pour relancer.
 *
 * ⚠️ On ne devine JAMAIS. Une réponse refusée relance la question ; elle n'est pas enregistrée
 * « au mieux ». Ces quatre champs finissent dans un document qui porte le nom de la personne
 * et dans l'adresse à laquelle on lui écrit.
 */
export function captureProfileAnswer(step: ProfileStep, text: string | undefined): string | null {
  const trimmed = (text ?? '').trim().replace(/\s+/g, ' ');
  if (!trimmed || isRefusal(trimmed)) return null;
  if (trimmed.length > MAX_ANSWER_CHARS[step]) return null;

  if (step === 'email') return looksLikeEmail(trimmed) ? trimmed.toLowerCase() : null;
  // Un nom ou un poste doit contenir au moins une lettre — Unicode, jamais `[a-z]` : ce
  // produit sert des gens dont le nom ne s'écrit pas en alphabet latin.
  if (!/\p{L}/u.test(trimmed)) return null;
  if (trimmed.length < 2) return null;
  return trimmed;
}

/**
 * Reconstitue ce que la personne a déjà répondu, en appariant les tours du fil.
 *
 * ⚠️ On lit le fil dans l'ordre CHRONOLOGIQUE et on écrase au fur et à mesure : si quelqu'un
 * répond deux fois à la même question (parce que la première a été refusée, ou parce qu'il se
 * corrige), c'est la DERNIÈRE réponse qui compte. L'inverse figerait une faute de frappe.
 */
export function collectProfileAnswers(turns: readonly ProfileTurn[]): ProfileAnswers {
  const answers: ProfileAnswers = {};
  let awaiting: ProfileStep | null = null;

  for (const turn of turns) {
    if (turn.role === 'assistant') {
      awaiting = pendingProfileStep(turn.content);
      continue;
    }
    if (turn.role !== 'user' || !awaiting) continue;
    const value = captureProfileAnswer(awaiting, turn.content);
    if (value) answers[awaiting] = value;
    awaiting = null;
  }

  return answers;
}

/**
 * Ce que le dossier existant renseigne déjà.
 *
 * ⚠️ Le même vocabulaire des deux côtés — `ProfileSnapshot` et `ProfileAnswers` portent les
 * mêmes clés — pour qu'un champ ajouté un jour à la fiche ne puisse pas être oublié ici.
 */
export function answersFromRecord(
  record: Partial<Record<ProfileStep, string | null | undefined>> | null,
): ProfileAnswers {
  const answers: ProfileAnswers = {};
  if (!record) return answers;
  for (const step of PROFILE_STEP_ORDER) {
    const value = record[step];
    if (typeof value === 'string' && value.trim()) answers[step] = value.trim();
  }
  return answers;
}

/** Le premier champ encore absent, ou `null` quand le dossier est complet. */
export function nextProfileStep(answers: ProfileAnswers): ProfileStep | null {
  return PROFILE_STEP_ORDER.find((step) => !answers[step]?.trim()) ?? null;
}

/**
 * Relance quand la réponse n'est pas exploitable.
 *
 * ⚠️ Elle NOMME ce qui cloche. « Je n'ai pas compris » renvoie la personne à la même question
 * sans lui dire quoi changer — c'est la version inutile de cette phrase, et elle coûte un
 * aller-retour de plus sur un budget qui se compte à la journée.
 */
export function profileRetryReply(step: ProfileStep): string {
  if (step === 'email') {
    return (
      'Il me faut une adresse email complète, du genre `prenom.nom@kisso.com`. ' +
      `\n\n${PROFILE_QUESTIONS.email}`
    );
  }
  return `Je n’ai pas su en tirer une réponse. ${PROFILE_QUESTIONS[step]}`;
}

/** Ce qu'on annonce avant la première question, quand aucun dossier n'existe. */
export const PROFILE_CHAT_INTRO_NO_RECORD =
  'Je ne trouve pas encore de dossier à ton nom. On le crée ensemble, ici même — ' +
  'quatre questions, une réponse par message.';

/** Ce qu'on annonce quand le dossier existe mais qu'il lui manque des champs. */
export function profileChatIntroMissing(missing: readonly string[]): string {
  const list =
    missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(', ')} et ${missing.at(-1)!}`;
  return `J’ai bien un dossier à ton nom, mais il me manque ${list}. On complète ça ici, une réponse par message.`;
}

/** Ce qu'on dit quand l'enregistrement échoue — jamais « c'est enregistré ». */
export const PROFILE_CHAT_SAVE_FAILED =
  'Je n’ai pas réussi à enregistrer ton dossier. Ce n’est pas de ton fait — redis-moi ' +
  '« c’est fait » dans un instant et je réessaie.';
