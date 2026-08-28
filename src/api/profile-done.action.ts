import { verifyProfile } from '../features/onboarding/domain/services/profile-completion';
import { DrizzleEmployeeRepository } from '../features/employee/infrastructure/repositories/drizzle-employee.repository';
import { type NewcomerIdentity } from '../features/onboarding/domain/services/newcomer-identity';
import { DrizzleConversationRepository } from '../features/conversation/infrastructure/repositories/drizzle-conversation.repository';
import { deriveConversationId } from '../features/conversation/domain/value-objects/conversation-id';
import { DEFAULT_AGENT_ID } from '../features/notification/domain/services/agent-routing';
import { logger } from '../shared/logger';
import { getSlackInteractionsAdapter } from './slack-interaction-replies';

let cachedEmployeeRepo: DrizzleEmployeeRepository | undefined;
function employeeRepo(): DrizzleEmployeeRepository {
  cachedEmployeeRepo ??= new DrizzleEmployeeRepository();
  return cachedEmployeeRepo;
}

let cachedConversationRepo: DrizzleConversationRepository | undefined;
function conversationRepo(): DrizzleConversationRepository {
  cachedConversationRepo ??= new DrizzleConversationRepository();
  return cachedConversationRepo;
}

async function rememberAsked(slackUserId: string | undefined, text: string): Promise<void> {
  if (!slackUserId) return;
  const { channel } = await getSlackInteractionsAdapter().sendMessage(slackUserId, text);

  try {
    await conversationRepo().append({
      conversationId: deriveConversationId({ channel }),
      role: 'assistant',
      content: text,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: null,
    });
  } catch (error) {
    logger.error('Question d’entretien posée mais non mémorisée — la réponse ira à l’agent', {
      error: String(error),
    });
  }
}

export async function answerProfileDone(prefill: NewcomerIdentity): Promise<void> {
  const email = prefill.email?.trim();
  const employee = email ? await employeeRepo().findByEmail(email) : null;
  const verdict = verifyProfile(employee);

  logger.info('« C’est fait » vérifié', {
    slackUserId: prefill.slackUserId,
    complete: verdict.complete,
    missing: verdict.missing.length,
  });

  await rememberAsked(prefill.slackUserId, verdict.reply);
}
