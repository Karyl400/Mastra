import { describe, it, expect } from 'vitest';
import type { ConversationTurn } from '../../../src/features/conversation/domain/entities/conversation-turn';
import {
  CHARS_PER_TOKEN,
  CONVERSATION_TOKEN_BUDGET,
  estimateTokens,
  selectWindow,
} from '../../../src/features/conversation/domain/services/token-window';

const BASE = new Date('2026-08-11T02:55:00.000Z').getTime();

let sequence = 0;
function makeTurn(role: 'user' | 'assistant', content: string, id?: string): ConversationTurn {
  const index = sequence++;
  return {
    id: id ?? `t${index}`,
    conversationId: 'D0BJGBVB5HP',
    role,
    content,
    agentId: 'onboardingOrchestrator',
    slackUserId: role === 'user' ? 'U0BMBEJTBMJ' : null,
    createdAt: new Date(BASE + index * 1000),
  };
}

/** Contenu calibré pour coûter exactement `tokens` (à l'arrondi supérieur près). */
function contentOfTokens(tokens: number): string {
  return 'x'.repeat(Math.floor(tokens * CHARS_PER_TOKEN));
}

function totalCost(turns: ConversationTurn[]): number {
  return turns.reduce((sum, turn) => sum + estimateTokens(turn.content), 0);
}

describe('token-window — constantes', () => {
  it('expose le ratio calibré sur les mesures du projet', () => {
    expect(CHARS_PER_TOKEN).toBe(3.5);
  });

  it('expose le budget de 1600 tokens (marge de ~37 % sous les ~2540 disponibles à K=3)', () => {
    // Relevé de 1000 à 1600 le 2026-08-11 après le dégraissage du FLOOR (2100 → 1458 tokens
    // par agent) et le bornage des tool-results (`getEmployeeProfile` 2506 → 329 tokens).
    // La marge reste volontairement large : au-delà du plafond Groq l'échec est un HTTP 500,
    // pas une dégradation, et le repli Mistral a lui aussi échoué le 2026-08-08.
    expect(CONVERSATION_TOKEN_BUDGET).toBe(1600);
  });

  it('estime le coût à ceil(longueur / 3.5)', () => {
    // L'en-tête de sécurité : 1308 caractères ≈ 374 tokens (mesure de prod du 2026-08-08).
    expect(estimateTokens('x'.repeat(1308))).toBe(374);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('selectWindow — budget', () => {
  it('ne dépasse jamais le budget', () => {
    const turns = [
      makeTurn('user', contentOfTokens(30)),
      makeTurn('assistant', contentOfTokens(30)),
      makeTurn('user', contentOfTokens(30)),
      makeTurn('assistant', contentOfTokens(30)),
      makeTurn('user', contentOfTokens(30)),
      makeTurn('assistant', contentOfTokens(30)),
    ];

    const selected = selectWindow(turns, 100);

    expect(totalCost(selected)).toBeLessThanOrEqual(100);
  });

  it('retient tout quand le budget est large', () => {
    const turns = [
      makeTurn('user', contentOfTokens(10), 'u1'),
      makeTurn('assistant', contentOfTokens(10), 'a1'),
      makeTurn('user', contentOfTokens(10), 'u2'),
      makeTurn('assistant', contentOfTokens(10), 'a2'),
    ];

    expect(selectWindow(turns, CONVERSATION_TOKEN_BUDGET).map((t) => t.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ]);
  });

  it('renvoie une liste vide pour une entrée vide', () => {
    expect(selectWindow([], CONVERSATION_TOKEN_BUDGET)).toEqual([]);
  });

  it('renvoie une liste vide pour un budget nul ou négatif', () => {
    const turns = [makeTurn('user', contentOfTokens(1)), makeTurn('assistant', contentOfTokens(1))];
    expect(selectWindow(turns, 0)).toEqual([]);
    expect(selectWindow(turns, -50)).toEqual([]);
  });
});

describe("selectWindow — une paire user/assistant n'est JAMAIS coupée", () => {
  it("s'arrête avant une paire qui n'entre pas, plutôt que de garder l'assistant seul", () => {
    // 6 tours de 30 tokens, budget 100 :
    //   (u3,a3) = 60  → reste 40
    //   (u2,a2) = 60  > 40 → on s'arrête. On NE garde PAS a2 seul.
    const turns = [
      makeTurn('user', contentOfTokens(30), 'u1'),
      makeTurn('assistant', contentOfTokens(30), 'a1'),
      makeTurn('user', contentOfTokens(30), 'u2'),
      makeTurn('assistant', contentOfTokens(30), 'a2'),
      makeTurn('user', contentOfTokens(30), 'u3'),
      makeTurn('assistant', contentOfTokens(30), 'a3'),
    ];

    expect(selectWindow(turns, 100).map((t) => t.id)).toEqual(['u3', 'a3']);
  });

  it('laisse du budget inutilisé plutôt que de commencer par un assistant orphelin', () => {
    // 4 tours de 30 tokens, budget 100 (plafond par tour = 40, donc aucune troncature).
    //   (u2,a2) = 60 → reste 40
    //   (u1,a1) = 60 > 40 → on s'arrête.
    // Un parcours glouton tour par tour aurait encore fait entrer `a1` (30 ≤ 40) et placé en
    // TÊTE d'historique une réponse dont la question est absente.
    const turns = [
      makeTurn('user', contentOfTokens(30), 'u1'),
      makeTurn('assistant', contentOfTokens(30), 'a1'),
      makeTurn('user', contentOfTokens(30), 'u2'),
      makeTurn('assistant', contentOfTokens(30), 'a2'),
    ];

    const selected = selectWindow(turns, 100);

    expect(selected.map((t) => t.id)).toEqual(['u2', 'a2']);
    expect(selected[0].role).toBe('user');
    expect(totalCost(selected)).toBeLessThan(100); // budget volontairement non épuisé
  });

  it("écarte une salve d'assistants dont la question a disparu de la fenêtre", () => {
    // Cas réel : le `limit` de requête ou le TTL a coupé le tour utilisateur d'origine.
    const turns = [
      makeTurn('assistant', contentOfTokens(10), 'a0'),
      makeTurn('user', contentOfTokens(10), 'u1'),
      makeTurn('assistant', contentOfTokens(10), 'a1'),
    ];

    expect(selectWindow(turns, CONVERSATION_TOKEN_BUDGET).map((t) => t.id)).toEqual(['u1', 'a1']);
  });

  it("garde ensemble les deux messages d'une double réponse du bot", () => {
    // Le bot poste parfois deux messages pour un seul message utilisateur : la salve entière
    // appartient à la même unité que la question.
    const turns = [
      makeTurn('user', contentOfTokens(10), 'u1'),
      makeTurn('assistant', contentOfTokens(10), 'a1'),
      makeTurn('assistant', contentOfTokens(10), 'a1bis'),
    ];

    expect(selectWindow(turns, CONVERSATION_TOKEN_BUDGET).map((t) => t.id)).toEqual([
      'u1',
      'a1',
      'a1bis',
    ]);
  });

  it('conserve un dernier tour utilisateur non encore répondu', () => {
    const turns = [
      makeTurn('user', contentOfTokens(20), 'u1'),
      makeTurn('assistant', contentOfTokens(20), 'a1'),
      makeTurn('user', contentOfTokens(20), 'u2'),
    ];

    expect(selectWindow(turns, 100).map((t) => t.id)).toEqual(['u1', 'a1', 'u2']);
  });
});

describe('selectWindow — ordre chronologique en sortie', () => {
  it('renvoie du plus ancien au plus récent malgré un parcours à rebours', () => {
    const turns = [
      makeTurn('user', contentOfTokens(10), 'u1'),
      makeTurn('assistant', contentOfTokens(10), 'a1'),
      makeTurn('user', contentOfTokens(10), 'u2'),
      makeTurn('assistant', contentOfTokens(10), 'a2'),
    ];

    const selected = selectWindow(turns, CONVERSATION_TOKEN_BUDGET);
    const timestamps = selected.map((t) => t.createdAt.getTime());

    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });
});

describe('selectWindow — un tour géant est TRONQUÉ, pas exclu', () => {
  it('tronque au-delà de 40 % du budget et suffixe par « … »', () => {
    // Budget 100 → plafond par tour = 40 tokens = 140 caractères.
    const giant = makeTurn('user', 'y'.repeat(5000), 'u1');

    const selected = selectWindow([giant], 100);

    expect(selected.map((t) => t.id)).toEqual(['u1']);
    expect(selected[0].content).toHaveLength(140);
    expect(selected[0].content.endsWith('…')).toBe(true);
    expect(estimateTokens(selected[0].content)).toBeLessThanOrEqual(40);
  });

  it('ne touche pas un tour sous le plafond de 40 %', () => {
    const small = makeTurn('user', contentOfTokens(20), 'u1');
    const selected = selectWindow([small], 100);
    expect(selected[0].content).toBe(small.content);
    expect(selected[0].content.endsWith('…')).toBe(false);
  });

  it('une paire de tours géants tient encore dans le budget une fois tronquée', () => {
    const turns = [
      makeTurn('user', 'y'.repeat(9000), 'u1'),
      makeTurn('assistant', 'z'.repeat(9000), 'a1'),
    ];

    const selected = selectWindow(turns, 100);

    expect(selected.map((t) => t.id)).toEqual(['u1', 'a1']);
    expect(totalCost(selected)).toBeLessThanOrEqual(100);
  });

  it("ne mute pas les tours d'entrée", () => {
    const giant = makeTurn('user', 'y'.repeat(5000), 'u1');
    selectWindow([giant], 100);
    expect(giant.content).toHaveLength(5000);
  });
});
