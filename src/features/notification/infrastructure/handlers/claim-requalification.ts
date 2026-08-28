import { logger } from '../../../../shared/logger';
import {
  detectUnsupportedCompletionClaim,
  detectUnsupportedDeliveryPromise,
  hasActingToolCall,
  promisesWithoutActing,
} from '../../domain/services/claim-reconciliation';

export function requalifyClaims(
  input: {
    toolCalls: string[] | null;
    acted: boolean;
    answer: string;
  },
  context: { agentId: string; channel: string; conversationId: string },
): { unsupportedClaim: string | null; deliveryPromise: string | null } {
  const { toolCalls, acted, answer } = input;

  const unsupportedClaim =
    toolCalls !== null && !acted && !hasActingToolCall(toolCalls)
      ? detectUnsupportedCompletionClaim(answer)
      : null;

  if (unsupportedClaim) {
    logger.error('Agent claimed a completed action while no tool ran — response requalified', {
      ...context,
      claim: unsupportedClaim,
    });
  }

  const deliveryPromise =
    toolCalls !== null && !acted && promisesWithoutActing(toolCalls)
      ? detectUnsupportedDeliveryPromise(answer)
      : null;

  if (deliveryPromise) {
    logger.error('Agent promised an automatic delivery that nothing performs', {
      ...context,
      claim: deliveryPromise,
    });
  }

  return { unsupportedClaim, deliveryPromise };
}
