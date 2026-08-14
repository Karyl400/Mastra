import { z } from 'zod';
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
  position: { blockId: 'profile_position', actionId: 'position' },
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
  /**
   * Instant du `team_join`, en ISO 8601 — la date d'arrivée RÉELLE.
   *
   * Ce n'est pas une valeur de remplissage : c'est le fait que Slack vient d'annoncer, et
   * c'est précisément pour cela que le sélecteur de date a pu disparaître de la modale. Une
   * question dont le serveur connaît déjà la réponse ne doit pas être posée — chaque champ
   * demandé est un champ qu'on peut remplir de travers ou laisser en plan.
   *
   * Absent sur un bouton émis AVANT le 2026-08-13 : l'appelant retombe alors sur l'instant
   * courant.
   */
  joinedAt?: string | null;
}

/** Ce que la route relit de `view.state.values`, avant validation. */
export interface ProfileSubmission {
  email: string;
  firstName: string;
  lastName: string;
  position: string;
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
    j: prefill.joinedAt ?? undefined,
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
    const parsed = JSON.parse(value) as {
      u?: string;
      e?: string;
      f?: string;
      l?: string;
      j?: string;
    };
    return {
      slackUserId: parsed.u || fallbackUserId,
      email: parsed.e ?? null,
      firstName: parsed.f ?? null,
      lastName: parsed.l ?? null,
      joinedAt: parsed.j ?? null,
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
    //
    // ⚠️ Même encodage que le `value` du bouton (`encodePrefill`) : c'est `decodePrefill`
    // qui le relit des DEUX côtés. Deux formes proches mais distinctes auraient divergé au
    // premier champ ajouté, et l'écart ne se serait vu qu'en production, sur la soumission.
    private_metadata: encodePrefill(prefill),
    blocks: [
      textInput(PROFILE_FIELDS.email, 'Email professionnel', {
        initial: prefill.email,
        placeholder: 'prenom.nom@kisso.com',
      }),
      textInput(PROFILE_FIELDS.firstName, 'Prénom', { initial: prefill.firstName }),
      textInput(PROFILE_FIELDS.lastName, 'Nom', { initial: prefill.lastName }),
      // SEUL champ réellement demandé. Le département n'est plus collecté, et la date de
      // début est déjà connue — c'est l'instant du `team_join`, transporté par `joinedAt`.
      // Une question dont le serveur a la réponse est une occasion de se tromper offerte
      // à l'arrivant, pas une information gagnée.
      textInput(PROFILE_FIELDS.position, 'Poste', { placeholder: 'Software Engineer' }),
    ],
  } as SlackModalView;
}

/* -------------------------------------------------------------------------- *
 * Relecture de la soumission
 * -------------------------------------------------------------------------- */

/**
 * Valeur brute d'un champ, selon son type de saisie.
 *
 * Quatre formes coexistent dans `view.state.values` : `value` pour une saisie
 * texte, `selected_option.value` pour une liste simple, `selected_options` (au
 * PLURIEL) pour un `multi_static_select`, `selected_date` pour un sélecteur de date.
 *
 * ⚠️ `selected_options` est déclaré ICI parce que c'est la forme réelle du payload Slack,
 * commune à toutes les modales — mais `readProfileSubmission` ne le lit PAS : la modale de
 * profil n'a que des champs texte. C'est `readInterviewSubmission` qui l'exploite. Deux
 * types distincts pour un même payload auraient divergé, et l'écart ne se serait vu qu'en
 * production, sur une soumission.
 */
interface SlackStateValue {
  value?: string | null;
  selected_date?: string | null;
  selected_option?: { value?: string | null } | null;
  selected_options?: ReadonlyArray<{ value?: string | null }> | null;
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
    position: readField(state, PROFILE_FIELDS.position),
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
  position: z
    .string()
    .trim()
    .min(VALIDATION_CONSTRAINTS.POSITION.MIN_LENGTH, 'Intitulé de poste trop court')
    .max(VALIDATION_CONSTRAINTS.POSITION.MAX_LENGTH, 'Intitulé de poste trop long')
    .regex(VALIDATION_CONSTRAINTS.POSITION.PATTERN, 'Caractères non autorisés dans le poste'),
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

/**
 * Date de début, DÉRIVÉE de l'arrivée Slack.
 *
 * Le sélecteur de date a disparu de la modale parce que la réponse est déjà connue : la
 * personne commence le jour où le workspace l'annonce. Le repli sur `now` ne concerne que les
 * boutons émis AVANT le 2026-08-13, dont le `value` ne porte pas `joinedAt` — et un repli sur
 * l'instant courant est exact pour eux aussi, à ceci près qu'il date la SOUMISSION plutôt que
 * l'arrivée.
 *
 * ⚠️ Le passage par `slice(0, 10)` puis `normalizeStartDate` est délibéré : il borne au JOUR,
 * en UTC, sans jamais reconstruire une `Date` à partir d'une chaîne locale — le « correctif »
 * naturel `new Date(d + 'T00:00:00')` décale d'un jour dès que le runtime n'est pas en UTC.
 */
export function startDateFromJoin(joinedAt: string | null | undefined, now: Date): string {
  const parsed = joinedAt ? new Date(joinedAt) : null;
  const valid = parsed && !Number.isNaN(parsed.getTime()) ? parsed : now;
  return normalizeStartDate(valid.toISOString().slice(0, 10));
}
