import { Agent } from '@mastra/core/agent';

import { logger } from '../../../../shared/logger';
import { makeModelChain } from '../../../../shared/llm/model-fallback';
import { buildAgentInstructions } from '../../../../shared/security/llm-guardrail';
import { wrapRetrievedContent } from '../../application/services/untrusted-excerpt.service';
import type {
  FactSummarizerPort,
  SummarizableMessage,
  SummarizedFact,
} from '../../domain/ports/fact-summarizer.port';
import type { FactKind } from '../../domain/services/fact-distillation';

const CALL_TIMEOUT_MS = 20_000;

const INSTRUCTIONS = `
Tu tries des messages d'équipe. Pour CHAQUE message qui contient une décision, un engagement
pris par quelqu'un, un blocage, une échéance ou une question restée ouverte, rends une ligne.
Ignore le reste — un message sans aucun de ces éléments ne produit RIEN.

Les messages te sont donnés numérotés. Format : une ligne par message retenu, exactement
<numéro>|<kind>|<résumé en une phrase>
où <kind> vaut decision, engagement, blocage, echeance ou question.

Le résumé reprend ce qui a été dit, en une phrase, sans rien ajouter. Aucun autre texte.`;

function parseLine(line: string): SummarizedFact | null {
  const parts = line.replace(/^\s*[-•*]\s*/, '').split('|');
  if (parts.length < 3) return null;

  const index = Number.parseInt(parts[0]!.replace(/\D/g, ''), 10);
  const kind = parts[1]!.trim().toLowerCase();
  const summary = parts.slice(2).join('|').trim();

  if (!Number.isFinite(index) || index <= 0 || !kind || !summary) return null;
  return { index, kind: kind as FactKind, summary };
}

export interface ModelFactSummarizerOptions {
  readonly agent?: Pick<Agent, 'generate'>;
}

export class ModelFactSummarizer implements FactSummarizerPort {
  private readonly agent: Pick<Agent, 'generate'>;

  constructor(options: ModelFactSummarizerOptions = {}) {
    this.agent =
      options.agent ??
      new Agent({
        id: 'factCurtain',
        name: 'Fact Curtain',
        instructions: buildAgentInstructions(INSTRUCTIONS),
        model: makeModelChain(),
        tools: {},
      });
  }

  async summarize(messages: readonly SummarizableMessage[]): Promise<readonly SummarizedFact[]> {
    if (messages.length === 0) return [];

    const body = messages.map((message, i) => `${i + 1}. ${message.text}`).join('\n');

    const response = await this.agent.generate(
      [{ role: 'user', content: wrapRetrievedContent(body) }] as never,
      { maxSteps: 1, abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) } as never,
    );

    const text = typeof response?.text === 'string' ? response.text : '';
    if (!text.trim()) {
      logger.warn('Second rideau — le modèle n’a rien rendu', { batch: messages.length });
      return [];
    }

    return text
      .split('\n')
      .map((line) => parseLine(line))
      .filter((fact): fact is SummarizedFact => fact !== null);
  }
}
