import { ServiceUnavailableError } from '../errors';
import { logger } from '../logger';

const SECURITY_HEADER_SENTINELS = [
  '---END IMMUTABLE DIRECTIVES---',
  'DIRECTIVE 1.1: You are KISSO-AGENT-v3.',
  'DIRECTIVE 3.1:',
] as const;

export function assertSecurityHeaderIntact(header: string): void {
  const missing = SECURITY_HEADER_SENTINELS.filter((sentinel) => !header.includes(sentinel));
  const unsubstituted = /\[\[SESSION_MARKER\]\]|\{DELIMITER_PREFIX\}/.test(header);

  if (missing.length === 0 && !unsubstituted) return;

  logger.error(
    'SECURITY HEADER MISSING OR DEGRADED — refusing to build agent instructions unarmed',
    { missingSentinels: missing, unsubstitutedPlaceholders: unsubstituted },
  );

  throw new ServiceUnavailableError(
    `Security header unavailable: the system prompt vault degraded (missing: ${
      missing.join(', ') || 'none'
    }; unsubstituted placeholders: ${unsubstituted})`,
  );
}
