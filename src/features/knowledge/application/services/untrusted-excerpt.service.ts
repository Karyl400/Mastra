import { SessionManager, wrapExternalData } from '../../../../shared/security/llm-guardrail';

const excerptSessionManager = new SessionManager();

const EXCERPT_SESSION_ID = 'knowledge-retrieved-content';

export function wrapRetrievedContent(text: string, preface?: string): string {
  const wrapped = wrapExternalData(text, EXCERPT_SESSION_ID, excerptSessionManager);
  return preface ? `${preface}\n${wrapped}` : wrapped;
}
