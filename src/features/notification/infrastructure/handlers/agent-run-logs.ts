import { logger } from '../../../../shared/logger';

export function logSanitizerVerdicts(
  safeOutput: { redacted: string[]; strippedUrls: string[] },
  context: { agentId: string; channel: string },
): void {
  if (safeOutput.redacted.length > 0) {
    logger.error('Agent output carried internal markers — response replaced', {
      ...context,
      markers: safeOutput.redacted,
    });
  }

  if (safeOutput.strippedUrls.length > 0) {
    logger.error('Agent output carried fabricated links — links removed', {
      ...context,
      hosts: safeOutput.strippedUrls,
    });
  }
}

export function logResponseShape(
  shape: { empty: boolean; truncated: boolean },
  context: {
    agentId: string;
    channel: string;
    durationMs: number;
    steps: number | null;
    length: number;
  },
): void {
  const { agentId, channel, durationMs, steps, length } = context;

  if (shape.empty) {
    logger.error('Le modèle n’a rien produit — refus neutre rendu par défaut', {
      agentId,
      channel,
      durationMs,
      steps,
    });
  }

  if (shape.truncated) {
    logger.warn('Réponse coupée par le plafond de sortie du fournisseur', {
      agentId,
      channel,
      length,
    });
  }
}

export function readSteps(response: unknown): number | null {
  const steps = (response as { steps?: unknown }).steps;
  return Array.isArray(steps) ? steps.length : null;
}

export function readInputTokens(response: unknown): number | null {
  const usage = (response as { usage?: { inputTokens?: unknown } }).usage;
  return typeof usage?.inputTokens === 'number' ? usage.inputTokens : null;
}
