import { randomBytes } from 'crypto';

import { SecurityBlockError } from '../errors';
import { NEUTRAL_REFUSAL } from './agent-output';
import { SystemPromptVault } from './system-prompt-vault';
import { createFixedSessionManager } from './session-manager';
import { wrapUserInput } from './input-wrapping';
import { SYSTEM_PROMPT_TEMPLATE } from './system-prompt-template';
import { assertSecurityHeaderIntact } from './security-header';
import type { ISessionManager } from './guardrail-types';

export { normalizeForDetection } from './homoglyph-folding';
export { detectInjectionAttempts } from './injection-patterns';
export { KeyManager } from './key-manager';
export { DelimiterGenerator } from './delimiter-generator';
export { SessionManager, createFixedSessionManager } from './session-manager';
export { SystemPromptVault } from './system-prompt-vault';
export { MAX_USER_INPUT_LENGTH, wrapUserInput, wrapExternalData } from './input-wrapping';
export { assertSecurityHeaderIntact } from './security-header';
export { SYSTEM_PROMPT_TEMPLATE as SYSTEM_SECURITY_PROMPT } from './system-prompt-template';
export type * from './guardrail-types';

export function securityRefusalMessage(error: unknown): string | undefined {
  return error instanceof SecurityBlockError ? NEUTRAL_REFUSAL : undefined;
}

const PROCESS_SESSION_ID = `process-${randomBytes(16).toString('hex')}`;

const applicationVault = new SystemPromptVault({
  masterSecret: process.env.SYSTEM_PROMPT_VAULT_SECRET || randomBytes(32).toString('hex'),
});

const applicationSessionManager: ISessionManager = createFixedSessionManager(PROCESS_SESSION_ID);

const { encrypted: encryptedSystemPrompt } = applicationVault.encrypt(SYSTEM_PROMPT_TEMPLATE);

export function buildAgentInstructions(businessInstructions: string): string {
  const populated = applicationVault.getPrompt(PROCESS_SESSION_ID, encryptedSystemPrompt);
  const session = applicationSessionManager.getOrCreate(PROCESS_SESSION_ID);
  const securityHeader = populated.replace(/\{DELIMITER_PREFIX\}/g, session.delimiters.tagPrefix);

  assertSecurityHeaderIntact(securityHeader);

  return `${securityHeader}\n\n${businessInstructions}`;
}

export function wrapAgentInput(text: string): string {
  return wrapUserInput(text, PROCESS_SESSION_ID, applicationSessionManager);
}
