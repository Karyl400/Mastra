import type { ConversationTurn } from '../entities/conversation-turn';

export const CHARS_PER_TOKEN = 3.5;

export const CONVERSATION_TOKEN_BUDGET = 1600;

export const MAX_TURN_BUDGET_SHARE = 0.4;

const TRUNCATION_SUFFIX = '…';

export function estimateTokens(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

export function selectWindow(
  turns: readonly ConversationTurn[],
  budgetTokens: number = CONVERSATION_TOKEN_BUDGET,
): ConversationTurn[] {
  if (budgetTokens <= 0 || turns.length === 0) return [];

  const maxTurnTokens = Math.floor(budgetTokens * MAX_TURN_BUDGET_SHARE);
  const units: ConversationTurn[][] = [];
  let remaining = budgetTokens;

  let index = turns.length - 1;
  while (index >= 0) {
    let start = index;

    if (turns[start].role === 'assistant') {
      while (start >= 0 && turns[start].role === 'assistant') start--;
      if (start < 0 || turns[start].role !== 'user') break;
    }

    const unit = turns.slice(start, index + 1).map((turn) => truncateToBudget(turn, maxTurnTokens));
    const unitCost = unit.reduce((sum, turn) => sum + estimateTokens(turn.content), 0);

    if (unitCost > remaining) break;

    remaining -= unitCost;
    units.push(unit);
    index = start - 1;
  }

  return units.reverse().flat();
}

function truncateToBudget(turn: ConversationTurn, maxTurnTokens: number): ConversationTurn {
  if (maxTurnTokens <= 0) return { ...turn, content: '' };
  if (estimateTokens(turn.content) <= maxTurnTokens) return turn;

  const maxChars = Math.floor(maxTurnTokens * CHARS_PER_TOKEN);
  const kept = turn.content.slice(0, Math.max(0, maxChars - TRUNCATION_SUFFIX.length));
  return { ...turn, content: `${kept}${TRUNCATION_SUFFIX}` };
}
