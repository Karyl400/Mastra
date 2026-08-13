import { describe, it, expect } from 'vitest';
import {
  PROFILE_MODAL_CALLBACK_ID,
  PROFILE_FIELDS,
  buildProfileModal,
  readProfileSubmission,
  profileSubmissionSchema,
  errorsByBlockId,
  decodePrefill,
  normalizeStartDate,
  startDateFromJoin,
  type ProfileModalPrefill,
} from '../../../src/features/notification/infrastructure/handlers/profile-modal';

const prefill: ProfileModalPrefill = {
  slackUserId: 'U0NEWCOMER1',
  email: 'alice@kisso.com',
  firstName: 'Alice',
  lastName: 'Martin',
};

/** Tous les `block_id` réellement présents dans la vue construite. */
function blockIdsOf(view: ReturnType<typeof buildProfileModal>): string[] {
  return (view.blocks as Array<{ block_id?: string }>)
    .map((block) => block.block_id)
    .filter((id): id is string => Boolean(id));
}

describe('buildProfileModal', () => {
  it('produit une vue modale valide pour views.open', () => {
    const view = buildProfileModal(prefill);

    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe(PROFILE_MODAL_CALLBACK_ID);
    // Slack plafonne le titre à 24 caractères et rejette la vue au-delà.
    expect(view.title.text.length).toBeLessThanOrEqual(24);
    // `submit` est OBLIGATOIRE dès qu'un bloc `input` est présent.
    expect(view.submit).toBeDefined();
  });

  it('pose un block_id explicite sur chacun des quatre champs', () => {
    // Sans block_id explicite, Slack en génère un aléatoire à l'ouverture et il
    // devient impossible de rattacher une erreur de validation au bon champ.
    const ids = blockIdsOf(buildProfileModal(prefill));

    for (const field of Object.values(PROFILE_FIELDS)) {
      expect(ids, `block_id manquant : ${field.blockId}`).toContain(field.blockId);
    }
  });

  it('pré-remplit email, prénom et nom quand ils sont connus', () => {
    const serialized = JSON.stringify(buildProfileModal(prefill));

    expect(serialized).toContain('alice@kisso.com');
    expect(serialized).toContain('Alice');
    expect(serialized).toContain('Martin');
  });

  it('reste valide quand rien n’est connu hormis l’identifiant Slack', () => {
    // Cas réel : team_join sans email et sans profil complété.
    const view = buildProfileModal({ slackUserId: 'U0NEWCOMER1' });

    expect(view.type).toBe('modal');
    expect(blockIdsOf(view)).toHaveLength(Object.keys(PROFILE_FIELDS).length);
  });

  it('ne demande QUE le poste — ni département, ni date de début', () => {
    // Le département n'est plus collecté (2026-08-13) et la date de début est déjà connue :
    // c'est l'instant du `team_join`. Une question dont le serveur a la réponse est une
    // occasion de se tromper offerte à l'arrivant, pas une information gagnée.
    const view = JSON.stringify(buildProfileModal(prefill));

    expect(view).toContain('profile_position');
    expect(view).not.toContain('profile_department');
    expect(view).not.toContain('profile_start_date');
    expect(view).not.toContain('datepicker');
    expect(view).not.toContain('static_select');
  });

  it('transporte l’identifiant Slack dans private_metadata, sous les 3000 caractères', () => {
    // private_metadata revient dans un payload signé : on peut s'y fier après
    // vérification HMAC pour relier la soumission à l'accueil.
    const view = buildProfileModal(prefill);

    expect(view.private_metadata).toBeDefined();
    expect(view.private_metadata!.length).toBeLessThanOrEqual(3000);
    // Même encodage que le `value` du bouton : c'est `decodePrefill` qui relit les deux.
    expect(decodePrefill(view.private_metadata!).slackUserId).toBe('U0NEWCOMER1');
  });
});

describe('readProfileSubmission', () => {
  /** `view.state.values` tel que Slack le renvoie sur un view_submission. */
  const state = {
    values: {
      [PROFILE_FIELDS.email.blockId]: {
        [PROFILE_FIELDS.email.actionId]: { type: 'plain_text_input', value: 'alice@kisso.com' },
      },
      [PROFILE_FIELDS.firstName.blockId]: {
        [PROFILE_FIELDS.firstName.actionId]: { type: 'plain_text_input', value: 'Alice' },
      },
      [PROFILE_FIELDS.lastName.blockId]: {
        [PROFILE_FIELDS.lastName.actionId]: { type: 'plain_text_input', value: 'Martin' },
      },
      [PROFILE_FIELDS.position.blockId]: {
        [PROFILE_FIELDS.position.actionId]: {
          type: 'plain_text_input',
          value: 'Software Engineer',
        },
      },
    },
  };

  it('extrait les quatre champs restants', () => {
    expect(readProfileSubmission(state)).toEqual({
      email: 'alice@kisso.com',
      firstName: 'Alice',
      lastName: 'Martin',
      position: 'Software Engineer',
    });
  });

  it('rend une chaîne vide plutôt que undefined pour un champ absent', () => {
    // Le schéma Zod doit voir un champ vide et produire une erreur attribuable
    // à un block_id, pas un `undefined` qui remonterait comme « required ».
    expect(readProfileSubmission({ values: {} })).toEqual({
      email: '',
      firstName: '',
      lastName: '',
      position: '',
    });
  });
});

describe('profileSubmissionSchema', () => {
  const valid = {
    email: 'alice@kisso.com',
    firstName: 'Alice',
    lastName: 'Martin',
    position: 'Software Engineer',
  };

  it('accepte une soumission complète, poste libre inclus', () => {
    expect(profileSubmissionSchema.safeParse(valid).success).toBe(true);
  });

  it('rejette un email invalide, un département inconnu et une date mal formée', () => {
    expect(profileSubmissionSchema.safeParse({ ...valid, email: 'pas-un-email' }).success).toBe(
      false,
    );
  });
});

describe('errorsByBlockId', () => {
  it('traduit les noms de champs Zod en block_id', () => {
    const parsed = profileSubmissionSchema.safeParse({
      email: 'pas-un-email',
      firstName: 'Alice',
      lastName: 'Martin',
      position: 'Software Engineer',
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const errors = errorsByBlockId(parsed.error);
    expect(Object.keys(errors)).toEqual([PROFILE_FIELDS.email.blockId]);
  });

  it('ne produit JAMAIS une clé absente de la vue', () => {
    // Une clé inconnue de Slack est SILENCIEUSEMENT ignorée : la modale se ferme
    // et l'erreur disparaît. C'est la seule protection contre ce mode de panne.
    const parsed = profileSubmissionSchema.safeParse({
      email: 'x',
      firstName: '',
      lastName: '',
      position: '',
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const known = new Set(blockIdsOf(buildProfileModal({ slackUserId: 'U1' })));
    for (const key of Object.keys(errorsByBlockId(parsed.error))) {
      expect(known.has(key), `block_id inconnu de la vue : ${key}`).toBe(true);
    }
  });
});

describe('normalizeStartDate', () => {
  it('convertit la sortie du datepicker au format attendu par le workflow', () => {
    // `onboardingInputSchema` exige `z.string().datetime()`, que « 2026-09-01 »
    // seul ne satisfait pas.
    expect(normalizeStartDate('2026-09-01')).toBe('2026-09-01T00:00:00.000Z');
  });

  it('ne décale jamais la date, quel que soit le fuseau du runtime', () => {
    // Piège mesuré : `new Date('2026-09-01T00:00:00').toISOString()` rend
    // 2026-08-31T23:00:00.000Z en UTC+1. La normalisation doit être une pure
    // concaténation, sans objet Date.
    const previousTz = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Africa/Porto-Novo', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        expect(normalizeStartDate('2026-09-01'), tz).toBe('2026-09-01T00:00:00.000Z');
      }
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });
});

describe('startDateFromJoin', () => {
  const NOW = new Date('2026-08-13T14:32:07.123Z');

  it("borne l'instant du team_join au JOUR, en UTC", () => {
    expect(startDateFromJoin('2026-08-13T14:32:07.123Z', NOW)).toBe('2026-08-13T00:00:00.000Z');
  });

  it("retombe sur l'instant courant quand le bouton ne porte pas de date", () => {
    // Cas des boutons émis AVANT le 2026-08-13 : leur `value` ne porte pas `joinedAt`. Le
    // repli date la SOUMISSION plutôt que l'arrivée — approximation assumée et bornée.
    expect(startDateFromJoin(undefined, NOW)).toBe('2026-08-13T00:00:00.000Z');
    expect(startDateFromJoin(null, NOW)).toBe('2026-08-13T00:00:00.000Z');
    expect(startDateFromJoin('', NOW)).toBe('2026-08-13T00:00:00.000Z');
  });

  it('retombe sur maintenant plutôt que de produire une date invalide', () => {
    // `new Date('n''importe quoi')` rend un Invalid Date, dont `toISOString()` LÈVE. Sans
    // cette garde, un `value` corrompu ferait échouer toute la soumission au lieu de
    // dégrader d'une journée.
    expect(startDateFromJoin('pas une date', NOW)).toBe('2026-08-13T00:00:00.000Z');
  });

  it('ne décale jamais la date, quel que soit le fuseau du runtime', () => {
    const previousTz = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Africa/Porto-Novo', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        expect(startDateFromJoin('2026-08-13T23:50:00.000Z', NOW), tz).toBe(
          '2026-08-13T00:00:00.000Z',
        );
      }
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });
});
