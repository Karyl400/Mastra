import { z } from 'zod';
import { Department } from '../../../../shared/types';
import { VALIDATION_CONSTRAINTS } from '../../../../shared/validation';
import type { SlackBlock, SlackModalView } from '../providers/slack.adapter';

/**
 * Modale « Compléter mon profil » du flux d'arrivée.
 *
 * Ce module ne fait AUCUNE E/S : il construit la vue, relit la soumission et la
 * valide. La route se charge du HTTP, l'adaptateur de l'appel Slack. C'est ce
 * qui rend l'ensemble testable sans serveur ni jeton.
 */

/** Doit correspondre au `callback_id` lu par la route sur `view_submission`. */
export const PROFILE_MODAL_CALLBACK_ID = 'employee_profile';

/**
 * Correspondance champ ↔ (`block_id`, `action_id`), source unique de vérité.
 *
 * Les `block_id` sont posés EXPLICITEMENT. À défaut, Slack en génère un
 * aléatoire à l'ouverture de la vue, et il devient impossible de rattacher une
 * erreur de validation à un champ : la clé serait inconnue, donc **ignorée en
 * silence**, la modale se fermerait et l'erreur disparaîtrait.
 */
export const PROFILE_FIELDS = {
  email: { blockId: 'profile_email', actionId: 'email' },
  firstName: { blockId: 'profile_first_name', actionId: 'first_name' },
  lastName: { blockId: 'profile_last_name', actionId: 'last_name' },
  department: { blockId: 'profile_department', actionId: 'department' },
  position: { blockId: 'profile_position', actionId: 'position' },
  startDate: { blockId: 'profile_start_date', actionId: 'start_date' },
} as const;

/** Un champ de la modale, désigné par son descripteur plutôt que par sa clé. */
export interface ProfileFieldRef {
  readonly blockId: string;
  readonly actionId: string;
}

export interface ProfileModalPrefill {
  slackUserId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/** Ce que la route relit de `view.state.values`, avant validation. */
export interface ProfileSubmission {
  email: string;
  firstName: string;
  lastName: string;
  department: string;
  position: string;
  startDate: string;
}

/* -------------------------------------------------------------------------- *
 * Transport du pré-remplissage dans le bouton du DM
 * -------------------------------------------------------------------------- */

/**
 * Le `value` du bouton d'accueil transporte ce que Slack savait déjà au moment
 * de l'arrivée.
 *
 * C'est ce qui permet d'ouvrir la modale pré-remplie **sans aucune E/S** : le
 * `trigger_id` expire en 3 secondes, et un appel `users.info` au moment du clic
 * consommerait ce budget pour une information déjà connue. Slack plafonne ce
 * champ à 2000 caractères ; la charge utile fait moins de 200.
 */
export function encodePrefill(prefill: ProfileModalPrefill): string {
  return JSON.stringify({
    u: prefill.slackUserId,
    e: prefill.email ?? undefined,
    f: prefill.firstName ?? undefined,
    l: prefill.lastName ?? undefined,
  });
}

/**
 * Relit le `value` du bouton. Il revient dans un payload signé, donc digne de
 * confiance après vérification HMAC — mais un ancien message peut porter un
 * format antérieur, d'où le repli sur l'identifiant seul.
 */
export function decodePrefill(value: string | undefined, fallbackUserId = ''): ProfileModalPrefill {
  if (!value) return { slackUserId: fallbackUserId };

  try {
    const parsed = JSON.parse(value) as { u?: string; e?: string; f?: string; l?: string };
    return {
      slackUserId: parsed.u || fallbackUserId,
      email: parsed.e ?? null,
      firstName: parsed.f ?? null,
      lastName: parsed.l ?? null,
    };
  } catch {
    // Format historique : le `value` ne portait que l'identifiant Slack brut.
    return { slackUserId: value || fallbackUserId };
  }
}

/* -------------------------------------------------------------------------- *
 * Construction de la vue
 * -------------------------------------------------------------------------- */

function textInput(
  field: ProfileFieldRef,
  label: string,
  options: { initial?: string | null; placeholder?: string } = {},
): SlackBlock {
  const { blockId, actionId } = field;
  const element: Record<string, unknown> = { type: 'plain_text_input', action_id: actionId };

  if (options.initial) element.initial_value = options.initial;
  if (options.placeholder) {
    element.placeholder = { type: 'plain_text', text: options.placeholder };
  }

  return {
    type: 'input',
    block_id: blockId,
    label: { type: 'plain_text', text: label },
    element,
  } as SlackBlock;
}

function departmentSelect(): SlackBlock {
  const { blockId, actionId } = PROFILE_FIELDS.department;

  return {
    type: 'input',
    block_id: blockId,
    label: { type: 'plain_text', text: 'Département' },
    element: {
      type: 'static_select',
      action_id: actionId,
      placeholder: { type: 'plain_text', text: 'Choisir un département' },
      // Source unique de vérité : l'enum `Department`. Douze valeurs, très en
      // dessous du plafond Slack de 100 options.
      options: Object.values(Department).map((value) => ({
        text: { type: 'plain_text', text: value },
        value,
      })),
    },
  } as SlackBlock;
}

function startDatePicker(): SlackBlock {
  const { blockId, actionId } = PROFILE_FIELDS.startDate;

  return {
    type: 'input',
    block_id: blockId,
    label: { type: 'plain_text', text: 'Date de début' },
    element: {
      type: 'datepicker',
      action_id: actionId,
      placeholder: { type: 'plain_text', text: 'Sélectionner une date' },
    },
  } as SlackBlock;
}

/**
 * Vue de la modale, pré-remplie de ce que Slack sait déjà.
 *
 * `title` est plafonné à 24 caractères par Slack, et la vue est rejetée au-delà.
 * `submit` est obligatoire dès qu'un bloc `input` est présent — c'est l'oubli le
 * plus fréquent au premier essai.
 */
export function buildProfileModal(prefill: ProfileModalPrefill): SlackModalView {
  return {
    type: 'modal',
    callback_id: PROFILE_MODAL_CALLBACK_ID,
    title: { type: 'plain_text', text: 'Mon profil' },
    submit: { type: 'plain_text', text: 'Enregistrer' },
    close: { type: 'plain_text', text: 'Annuler' },
    // Revient dans un payload SIGNÉ : après vérification HMAC, on peut s'y fier
    // pour relier la soumission à l'accueil. Ne jamais y mettre de secret.
    private_metadata: JSON.stringify({ slackUserId: prefill.slackUserId }),
    blocks: [
      textInput(PROFILE_FIELDS.email, 'Email professionnel', {
        initial: prefill.email,
        placeholder: 'prenom.nom@kisso.com',
      }),
      textInput(PROFILE_FIELDS.firstName, 'Prénom', { initial: prefill.firstName }),
      textInput(PROFILE_FIELDS.lastName, 'Nom', { initial: prefill.lastName }),
      departmentSelect(),
      textInput(PROFILE_FIELDS.position, 'Poste', { placeholder: 'Software Engineer' }),
      startDatePicker(),
    ],
  } as SlackModalView;
}

/* -------------------------------------------------------------------------- *
 * Relecture de la soumission
 * -------------------------------------------------------------------------- */

/**
 * Valeur brute d'un champ, selon son type de saisie.
 *
 * Trois formes coexistent dans `view.state.values` : `value` pour une saisie
 * texte, `selected_option.value` pour une liste, `selected_date` pour un
 * sélecteur de date.
 */
interface SlackStateValue {
  value?: string | null;
  selected_date?: string | null;
  selected_option?: { value?: string | null } | null;
}

export interface SlackViewState {
  values?: Record<string, Record<string, SlackStateValue>>;
}

function readField(state: SlackViewState, field: ProfileFieldRef): string {
  const byBlock = new Map(Object.entries(state.values ?? {}));
  const byAction = new Map(Object.entries(byBlock.get(field.blockId) ?? {}));
  const raw = byAction.get(field.actionId);
  if (!raw) return '';

  // Une chaîne vide plutôt qu'`undefined` : le schéma produit alors une erreur
  // attribuable au champ, là où un `undefined` remonterait comme « required »
  // sans que la clé soit forcément celle attendue.
  return raw.value ?? raw.selected_option?.value ?? raw.selected_date ?? '';
}

export function readProfileSubmission(state: SlackViewState): ProfileSubmission {
  return {
    email: readField(state, PROFILE_FIELDS.email),
    firstName: readField(state, PROFILE_FIELDS.firstName),
    lastName: readField(state, PROFILE_FIELDS.lastName),
    department: readField(state, PROFILE_FIELDS.department),
    position: readField(state, PROFILE_FIELDS.position),
    startDate: readField(state, PROFILE_FIELDS.startDate),
  };
}

/* -------------------------------------------------------------------------- *
 * Validation
 * -------------------------------------------------------------------------- */

/**
 * Validation métier de la soumission.
 *
 * Ce schéma ne sert PAS d'`inputSchema` de tool : il n'est jamais sérialisé en
 * JSON Schema, donc la contrainte de platitude ne s'y applique pas. Les règles
 * restent néanmoins alignées sur les autres portes d'entrée — la modale est la
 * troisième, après le tool et le workflow, et une divergence y ferait entrer des
 * valeurs que les deux autres refusent.
 */
export const profileSubmissionSchema = z.object({
  email: z.string().trim().email('Adresse email invalide'),
  firstName: z
    .string()
    .trim()
    .min(VALIDATION_CONSTRAINTS.NAME.MIN_LENGTH, 'Prénom trop court')
    .max(VALIDATION_CONSTRAINTS.NAME.MAX_LENGTH, 'Prénom trop long')
    .regex(VALIDATION_CONSTRAINTS.NAME.PATTERN, 'Prénom : lettres, espaces, tirets et apostrophes'),
  lastName: z
    .string()
    .trim()
    .min(VALIDATION_CONSTRAINTS.NAME.MIN_LENGTH, 'Nom trop court')
    .max(VALIDATION_CONSTRAINTS.NAME.MAX_LENGTH, 'Nom trop long')
    .regex(VALIDATION_CONSTRAINTS.NAME.PATTERN, 'Nom : lettres, espaces, tirets et apostrophes'),
  department: z.nativeEnum(Department, {
    errorMap: () => ({ message: 'Département inconnu' }),
  }),
  position: z
    .string()
    .trim()
    .min(VALIDATION_CONSTRAINTS.POSITION.MIN_LENGTH, 'Intitulé de poste trop court')
    .max(VALIDATION_CONSTRAINTS.POSITION.MAX_LENGTH, 'Intitulé de poste trop long')
    .regex(VALIDATION_CONSTRAINTS.POSITION.PATTERN, 'Caractères non autorisés dans le poste'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Sélectionner une date de début'),
});

export type ValidatedProfile = z.infer<typeof profileSubmissionSchema>;

/**
 * Erreurs Zod converties en clés que Slack sait afficher.
 *
 * Slack exige des `block_id`. Une clé inconnue — un nom de champ Zod, par
 * exemple — est **silencieusement ignorée** : la modale se ferme et l'erreur
 * disparaît sans trace. La traduction passe donc par `PROFILE_FIELDS`, et toute
 * clé hors périmètre est écartée plutôt que transmise à l'aveugle.
 */
export function errorsByBlockId(error: z.ZodError): Record<string, string> {
  // Une `Map` plutôt qu'une indexation : la clé vient de Zod, donc de la saisie
  // utilisateur en dernière analyse, et une indexation d'objet par variable
  // ouvre la porte à `__proto__`.
  const blockIdByField = new Map<string, string>(
    Object.entries(PROFILE_FIELDS).map(([field, ref]) => [field, ref.blockId]),
  );

  const errors = new Map<string, string>();

  for (const [field, messages] of Object.entries(error.flatten().fieldErrors)) {
    const blockId = blockIdByField.get(field);
    const first = messages?.[0];
    if (blockId && first) errors.set(blockId, first);
  }

  return Object.fromEntries(errors);
}

/**
 * Date du `datepicker` au format exigé par `onboardingInputSchema`
 * (`z.string().datetime()`), que « 2026-09-01 » seul ne satisfait pas.
 *
 * ⚠️ Concaténation pure, jamais d'objet `Date`. Le « correctif » naturel
 * `new Date(d + 'T00:00:00').toISOString()` décale d'un jour dès que le runtime
 * n'est pas en UTC : mesuré en UTC+1, `2026-09-01` devient `2026-08-31T23:00Z`.
 * L'écart dépend de `TZ`, donc il ne se voit ni en test local ni en revue.
 */
export function normalizeStartDate(date: string): string {
  return `${date}T00:00:00.000Z`;
}
