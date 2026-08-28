import { logger } from '../../../../shared/logger';
import { wrapAgentInput } from '../../../../shared/security/llm-guardrail';
import { sanitizeAgentOutput } from '../../../../shared/security/agent-output';
import { AGENT_GENERATE_TIMEOUT_MS, AGENT_MAX_STEPS } from '../../../../shared/llm/model-fallback';
import {
  describeModelResponse,
  MODEL_TRUNCATED_NOTICE,
} from '../../../../shared/llm/model-response';
import {
  buildSlackRequestContext,
  readExcerptCoverage,
  readLoanDelivered,
  readStepBlocked,
} from '../../../../shared/slack-request-context';
import { readToolCallNames } from '../../domain/services/claim-reconciliation';
import type {
  AgentPipelineContext,
  AgentTurnState,
  SlackHandlerInternals,
  StepOutcome,
} from './handler-internals';
import { unwrapSanitizedInput } from './message-text';
import { buildMessages, loadPinnedFacts, rememberTurn } from './conversation-memory';
import { auditAgentRun } from './agent-run-audit';
import {
  logResponseShape,
  logSanitizerVerdicts,
  readInputTokens,
  readSteps,
} from './agent-run-logs';
import { requalifyClaims } from './claim-requalification';
import { composeAnswer } from './response-notices';
import { reportAgentTurn } from './agent-turn-epilogue';

function tryGetAgent(self: SlackHandlerInternals, agentId: string) {
  try {
    return self.mastra.getAgent(agentId);
  } catch (error) {
    logger.error('Agent not found in the Mastra registry', { agentId, error });
    return undefined;
  }
}

export async function runAgentTurn(
  self: SlackHandlerInternals,
  ctx: AgentPipelineContext,
  state: AgentTurnState,
): Promise<StepOutcome> {
  const {
    event,
    text,
    channel,
    threadTs,
    user,
    conversationId,
    history,
    requesterIdentity,
    accessLevel,
    progress,
    pendingEmailReminder,
    onboardingReminder,
  } = ctx;

  const stickyAgentId = history.at(-1)?.agentId;
  const agentId = self.routeToAgent(text, stickyAgentId);
  state.agentId = agentId;
  logger.info('Routing to agent', {
    agentId,
    stickyAgentId: stickyAgentId ?? null,
    sticky: Boolean(stickyAgentId) && agentId === stickyAgentId,
    historyTurns: history.length,
  });

  state.phase = 'resolve-agent';
  const agent = tryGetAgent(self, agentId);
  if (!agent) {
    await progress.resolve(
      "Je n'arrive pas à traiter ta demande — c'est un problème de mon côté. Réessaie, et " +
        'si ça recommence, remonte-le.',
    );
    logger.error('Agent introuvable dans le registre Mastra', { agentId });
    auditAgentRun(self, {
      user,
      agentId,
      status: 'failure',
      errorMessage: 'agent_unresolved',
      details: { phase: state.phase, durationMs: Date.now() - state.startedAt },
    });
    return 'blocked';
  }

  state.phase = 'wrap';
  const safeInput = wrapAgentInput(text);

  await rememberTurn(self, {
    conversationId,
    role: 'user',
    content: unwrapSanitizedInput(safeInput, text),
    agentId,
    slackUserId: user ?? null,
  });

  state.phase = 'generate';
  const identity = await requesterIdentity;

  const pinnedFacts = await loadPinnedFacts(self, user);

  const requestContext = buildSlackRequestContext({
    channel,
    threadTs,
    eventTs: event.ts,
    slackUserId: user,
    employeeId: identity.employeeId ?? undefined,
    accessLevel,
  });

  const response = await agent.generate(
    buildMessages(self, history, safeInput, {
      agentId,
      slackUserId: user,
      identity,
      pinnedFacts,
    }),
    {
      requestContext,
      maxSteps: AGENT_MAX_STEPS,
      abortSignal: AbortSignal.timeout(AGENT_GENERATE_TIMEOUT_MS),
    },
  );
  const durationMs = Date.now() - state.startedAt;

  state.phase = 'sanitize';
  const shape = describeModelResponse(response);
  const safeOutput = sanitizeAgentOutput(response.text);

  logSanitizerVerdicts(safeOutput, { agentId, channel });

  logResponseShape(shape, {
    agentId,
    channel,
    durationMs,
    steps: readSteps(response),
    length: safeOutput.text.length,
  });

  const toolCalls = readToolCallNames(response);
  const loanDelivered = readLoanDelivered(requestContext);
  const acted = loanDelivered !== undefined;
  const { unsupportedClaim, deliveryPromise } = requalifyClaims(
    { toolCalls, acted, answer: safeOutput.text },
    { agentId, channel, conversationId },
  );

  await rememberTurn(self, {
    conversationId,
    role: 'assistant',
    content: safeOutput.text,
    agentId,
    slackUserId: null,
  });

  state.phase = 'post';
  const excerptCoverage = readExcerptCoverage(requestContext);

  await progress.resolve(
    composeAnswer({
      answer: safeOutput.text,
      requestContext,
      text,
      agentId,
      unsupportedClaim,
      deliveryPromise,
      notes: [
        shape.truncated ? MODEL_TRUNCATED_NOTICE : undefined,
        excerptCoverage,
        pendingEmailReminder,
        onboardingReminder,
      ],
    }),
  );

  reportAgentTurn(self, {
    user,
    agentId,
    channel,
    conversationId,
    redacted: safeOutput.redacted.length,
    durationMs,
    steps: readSteps(response),
    inputTokens: readInputTokens(response),
    toolCalls,
    unsupportedClaim,
    deliveryPromise,
    truncated: shape.truncated,
  });

  return readStepBlocked(requestContext) ? 'blocked' : 'served';
}
