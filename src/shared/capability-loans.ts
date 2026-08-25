export type LoanDelivery = 'requester';

export interface CapabilityLoan {
  readonly name: string;
  readonly borrowedFrom: string;
  readonly lentTo: readonly string[];
  readonly extendsTool: string;
  readonly deliversTo: LoanDelivery;
  readonly boundary: string;
  readonly boundaryModule: string;
  readonly executedBy: string;
  readonly why: string;
  readonly safeBecause: string;
}

export const CAPABILITY_LOANS: readonly CapabilityLoan[] = [
  {
    name: 'channelDigest',
    borrowedFrom: 'generateDocument',
    lentTo: ['knowledgeAgent'],
    extendsTool: 'getChannelHistory',
    deliversTo: 'requester',
    boundary: 'authorizeChannelRead',
    boundaryModule: 'src/features/knowledge/domain/services/disclosure-policy.ts',
    executedBy: 'src/features/knowledge/application/tools/get-channel-history.ts',
    why:
      '« Résume ce canal et donne-le-moi en PDF » n’était servable par aucun agent : seul ' +
      'knowledgeAgent sait lire un canal, seul onboardingOrchestrator sait rendre un document. ' +
      'En production, la demande recevait un contournement qui reportait le travail sur ' +
      'l’humain — « copie-moi le texte que tu souhaites que je résume ».',
    safeBecause:
      'Le prêt ne comporte AUCUN destinataire. Le fichier contient exactement les extraits que ' +
      'l’outil avait déjà le droit de rendre en texte, après la MÊME frontière ' +
      '(authorizeChannelRead), et il est déposé exactement là où ce texte serait allé — le fil ' +
      'où la question a été posée. On change le format, pas le flux d’information : il n’y a ' +
      'donc rien de nouveau à exfiltrer. Un prêt de l’outil lui-même, à l’inverse, créerait un ' +
      'chemin qui n’existe pas.',
  },
];

export function loansTo(agentId: string): readonly CapabilityLoan[] {
  return CAPABILITY_LOANS.filter((loan) => loan.lentTo.includes(agentId));
}

export function isLentTo(agentId: string, capability: string): boolean {
  return loansTo(agentId).some((loan) => loan.name === capability);
}
