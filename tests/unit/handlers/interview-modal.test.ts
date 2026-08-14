import { describe, it, expect } from 'vitest';

import {
  INTERVIEW_FIELDS,
  INTERVIEW_MODAL_CALLBACK_ID,
  MAX_FREE_TEXT_CHARS,
  MAX_INTERVIEW_CHANNELS,
  buildInterviewModal,
  decodeInterviewPrefill,
  encodeInterviewPrefill,
  interviewSubmissionSchema,
  readInterviewSubmission,
  type InterviewPrefill,
} from '../../../src/features/notification/infrastructure/handlers/interview-modal';
import { interviewDoneReply } from '../../../src/features/notification/infrastructure/handlers/interview-invite';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * L'entretien REMPLACE la feature `questionnaire`
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Relevé sur la Turso le 2026-08-14 : **5 questionnaires enregistrés, 0 réponse**. Il
 * n'existait ni formulaire Block Kit, ni modale, ni route de soumission — rien qu'un humain
 * puisse remplir. Le tool le disait lui-même dans son `hint`.
 *
 * L'entretien inverse la construction : le formulaire existe D'ABORD, en code, et sa
 * soumission produit un EFFET RÉEL (l'invitation aux canaux). Ces tests verrouillent les
 * propriétés dont dépend cet effet.
 */

const CHANNELS = [
  { channelId: 'CMLKC4S5T', name: 'kisso-hq' },
  { channelId: 'C0BP3RCLLA1', name: 'engineering-chat' },
  { channelId: 'C09TRLL2KEW', name: 'random' },
];

const prefill: InterviewPrefill = {
  employeeId: 'd36b78dc-a039-4160-b86a-bd3d2a722b6c',
  slackUserId: 'U0BJBDGTJUD',
  channels: CHANNELS,
};

function blocksOf(view: unknown): Array<Record<string, unknown>> {
  return (view as { blocks: Array<Record<string, unknown>> }).blocks;
}

describe('encodeInterviewPrefill / decodeInterviewPrefill', () => {
  it('fait l aller-retour sans perte', () => {
    expect(decodeInterviewPrefill(encodeInterviewPrefill(prefill))).toEqual(prefill);
  });

  it('tient très largement sous les 2000 caractères imposés par Slack', () => {
    // Au-delà, Slack REJETTE le bouton : le message part sans lui, et le symptôme — un DM
    // sans action possible — ne désigne pas sa cause.
    const plein: InterviewPrefill = {
      ...prefill,
      channels: Array.from({ length: MAX_INTERVIEW_CHANNELS }, (_, i) => ({
        channelId: `C${String(i).padStart(10, '0')}`,
        name: `canal-au-nom-plutot-long-${i}`,
      })),
    };

    expect(encodeInterviewPrefill(plein).length).toBeLessThan(2000);
  });

  it('borne le nombre de canaux transportés', () => {
    const trop: InterviewPrefill = {
      ...prefill,
      channels: Array.from({ length: MAX_INTERVIEW_CHANNELS + 5 }, (_, i) => ({
        channelId: `C${String(i).padStart(10, '0')}`,
        name: `c${i}`,
      })),
    };

    expect(decodeInterviewPrefill(encodeInterviewPrefill(trop)).channels).toHaveLength(
      MAX_INTERVIEW_CHANNELS,
    );
  });

  it('écarte ce qui ne ressemble pas à un identifiant de canal', () => {
    // La vérification HMAC prouve que Slack a signé le payload, PAS que son contenu désigne
    // un canal. Cette valeur finit dans `conversations.invite`.
    const forge = JSON.stringify({
      e: 'emp',
      u: 'U1',
      c: [
        ['not-a-channel', 'x'],
        ['CMLKC4S5T', 'kisso-hq'],
        ['../../etc/passwd', 'y'],
      ],
    });

    expect(decodeInterviewPrefill(forge).channels).toEqual([
      { channelId: 'CMLKC4S5T', name: 'kisso-hq' },
    ]);
  });

  it('ne lève pas sur un format antérieur ou illisible', () => {
    // Un bouton d'hier ne doit pas faire échouer une soumission d'aujourd'hui.
    expect(decodeInterviewPrefill('U0LEGACY', 'U0FALLBACK').slackUserId).toBe('U0FALLBACK');
    expect(decodeInterviewPrefill(undefined, 'U0FALLBACK').channels).toEqual([]);
  });
});

describe('buildInterviewModal', () => {
  it('porte le callback_id que la route relit', () => {
    const view = buildInterviewModal(prefill) as { callback_id: string; title: { text: string } };

    expect(view.callback_id).toBe(INTERVIEW_MODAL_CALLBACK_ID);
    // Slack plafonne le titre à 24 caractères et REJETTE la vue au-delà.
    expect(view.title.text.length).toBeLessThanOrEqual(24);
  });

  it('propose les canaux en multi-select', () => {
    const bloc = blocksOf(buildInterviewModal(prefill)).find(
      (b) => b.block_id === INTERVIEW_FIELDS.channels.blockId,
    );
    const element = bloc?.element as { type: string; options: Array<{ value: string }> };

    expect(element.type).toBe('multi_static_select');
    expect(element.options.map((o) => o.value)).toEqual(CHANNELS.map((c) => c.channelId));
  });

  it('OMET le bloc canaux quand il n y en a aucun', () => {
    // ⚠️ Un `multi_static_select` avec `options: []` fait REJETER la vue entière par Slack
    // (`invalid_arguments`) : la modale ne s'ouvrirait pas du tout. Le cas est réel — une
    // base dont `slack_channels` n'a jamais été synchronisée.
    const blocs = blocksOf(buildInterviewModal({ ...prefill, channels: [] }));

    expect(blocs.some((b) => b.block_id === INTERVIEW_FIELDS.channels.blockId)).toBe(false);
    // Les deux questions libres, elles, gardent tout leur sens.
    expect(blocs.some((b) => b.block_id === INTERVIEW_FIELDS.dailyWork.blockId)).toBe(true);
  });

  it('rend TOUS les champs optionnels', () => {
    // Une modale validée à vide est un « non merci » légitime. Rendre la prose obligatoire
    // ferait abandonner qui n'a pas envie d'écrire — et lui coûterait ses canaux.
    const inputs = blocksOf(buildInterviewModal(prefill)).filter((b) => b.type === 'input');

    expect(inputs.length).toBeGreaterThan(0);
    for (const bloc of inputs) expect(bloc.optional).toBe(true);
  });
});

describe('readInterviewSubmission', () => {
  it('lit selected_options au PLURIEL', () => {
    // `multi_static_select` rend `selected_options`, là où `static_select` rend
    // `selected_option`. Le lecteur de la modale de profil ne lit que le singulier : les
    // fondre rendrait une liste vide en silence.
    const state = {
      values: {
        [INTERVIEW_FIELDS.channels.blockId]: {
          [INTERVIEW_FIELDS.channels.actionId]: {
            selected_options: [{ value: 'CMLKC4S5T' }, { value: 'C09TRLL2KEW' }],
          },
        },
        [INTERVIEW_FIELDS.dailyWork.blockId]: {
          [INTERVIEW_FIELDS.dailyWork.actionId]: { value: 'je développe les API paiement' },
        },
      },
    };

    expect(readInterviewSubmission(state)).toEqual({
      channels: ['CMLKC4S5T', 'C09TRLL2KEW'],
      dailyWork: 'je développe les API paiement',
      workStyle: '',
    });
  });

  it('rend des champs vides plutôt que de lever sur un état absent', () => {
    expect(readInterviewSubmission({})).toEqual({ channels: [], dailyWork: '', workStyle: '' });
  });
});

describe('interviewSubmissionSchema', () => {
  it('ASSAINIT le texte libre — il ressort dans un PDF', () => {
    // `sanitizeAgentOutput` ne couvre QUE `response.text`. Ce texte-ci est écrit par un
    // humain et imprimé dans un document, canal de sortie que rien d'autre ne filtre : c'est
    // le trou exact par lequel `[SECURITY_BLOCK]` et `DIRECTIVE 3.1` sont sortis dans un PDF.
    const parsed = interviewSubmissionSchema.parse({
      channels: [],
      dailyWork: '  je code  ',
      workStyle: '',
    });

    expect(parsed.dailyWork).toBe('je code');
  });

  it('refuse un texte plus long que la borne de la vue', () => {
    const trop = 'a'.repeat(MAX_FREE_TEXT_CHARS + 1);

    expect(
      interviewSubmissionSchema.safeParse({ channels: [], dailyWork: trop, workStyle: '' }).success,
    ).toBe(false);
  });

  it('refuse un identifiant de canal mal formé', () => {
    expect(
      interviewSubmissionSchema.safeParse({
        channels: ['not-a-channel'],
        dailyWork: '',
        workStyle: '',
      }).success,
    ).toBe(false);
  });
});

describe('interviewDoneReply — la réponse NOMME ce qui a eu lieu', () => {
  it('distingue rejoint, déjà membre et échoué', () => {
    // Ce dépôt a payé trois fois la faute d'annoncer une action qui n'a pas eu lieu. Une
    // invitation échoue banalement : canal archivé depuis la dernière synchronisation
    // (26 des 32 de l'inventaire le sont), bot non membre.
    const reply = interviewDoneReply({
      joined: ['kisso-hq'],
      already: ['random'],
      failed: ['signals'],
    });

    expect(reply).toContain('#kisso-hq');
    expect(reply).toContain('#random');
    expect(reply).toContain('#signals');
    expect(reply).toMatch(/n'ai pas pu/i);
  });

  it('ne présente PAS « déjà membre » comme un échec', () => {
    const reply = interviewDoneReply({ joined: [], already: ['kisso-hq'], failed: [] });

    expect(reply).not.toMatch(/n'ai pas pu/i);
  });

  it('ne relance pas quand aucun canal n a été choisi', () => {
    // C'est un choix légitime, pas un échec.
    const reply = interviewDoneReply({ joined: [], already: [], failed: [] });

    expect(reply).toMatch(/aucun canal/i);
    expect(reply).not.toMatch(/n'ai pas pu/i);
  });
});
