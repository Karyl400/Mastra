import { ValidationError } from '../errors';

/**
 * LLM Guardrails: Input & Output Egress Filtering
 * Defends against:
 * - Jailbreak Prompts
 * - Output Leakage
 * - Obfuscated Injections
 */

const SUSPICIOUS_PATTERNS = [
  /ignore previous/i,
  /system prompt/i,
  /you are now/i,
  /forget everything/i,
  /developer mode/i,
  /DAN/i, // Do Anything Now
  /print your instructions/i,
  /bypassing/i,
  /base64/i // Attempting to use obfuscation
];

/**
 * Validates raw user input BEFORE it reaches the LLM.
 * @param input Raw text from user
 * @throws ValidationError if suspicious patterns are detected
 */
export function validateLLMInput(input: string): string {
  if (typeof input !== 'string') {
    throw new ValidationError('Input must be a string');
  }

  // Token Flooding Defense (Limit size)
  if (input.length > 10000) {
    throw new ValidationError('Input exceeds maximum allowed length (Token Flooding Defense).');
  }

  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(input)) {
      throw new ValidationError('Malicious pattern detected in input. Request blocked by Security Gateway.');
    }
  }

  return input;
}

/**
 * Validates LLM output BEFORE sending it to the user.
 * Defends against: System Prompt Extraction & Secret Leakage.
 * @param output Raw output from the LLM
 * @throws ValidationError if leakage is detected
 */
export function validateLLMOutput(output: string): string {
  if (typeof output !== 'string') return output;

  // Prevent System Prompt extraction
  if (output.includes('CRITICAL SYSTEM DIRECTIVES') || output.includes('CORE IDENTITY')) {
    throw new ValidationError('Egress Filter Block: Output contains internal system directives.');
  }

  // Prevent Secret Extraction (Naive regex for API keys or env vars)
  const secretPattern = /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][a-zA-Z0-9_\-]+["']/i;
  if (secretPattern.test(output)) {
    throw new ValidationError('Egress Filter Block: Potential secret leakage detected.');
  }

  return output;
}
