export const ASSISTANT_NAME = 'Marcel';

export const COMPANY_NAME = 'Kisso';

export const MACHINE_SELF_DESIGNATIONS: readonly RegExp[] = [
  /\bje suis (?:un |une )?(?:outil|agent|bot|robot|assistant|ia|intelligence artificielle)\b/i,
  /\ben tant qu(?:'|e )(?:outil|agent|bot|robot|assistant|ia)\b/i,
  /\bassistant (?:virtuel|automatique|conversationnel)\b/i,
  /\bje suis (?:un )?programme\b/i,
  /\bi(?:'m| am) (?:a |an )?(?:tool|bot|robot|assistant|ai|chatbot)\b/i,
];

export function namesItselfAsMachine(text: string): boolean {
  return MACHINE_SELF_DESIGNATIONS.some((pattern) => pattern.test(text));
}
