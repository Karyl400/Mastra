import { pickVariant } from '../../../../shared/reply-variants';

export const PROGRESS_MARKER_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  default: ['Je regarde ça…', 'Une seconde, je vérifie…', 'Je m’en occupe, deux secondes…'],
  onboardingOrchestrator: [
    'Je regarde ça…',
    'Une seconde, je vérifie…',
    'Je m’en occupe, deux secondes…',
  ],
  notificationAgent: ['Je m’en occupe…', 'Une seconde, je m’y mets…', 'Deux secondes, j’y suis…'],
  knowledgeAgent: [
    'Je cherche dans ce qui s’est dit…',
    'Je fouille dans les échanges, une seconde…',
    'Je retrouve ça…',
  ],
  recruitmentAgent: [
    'Je m’en occupe…',
    'Je regarde si c’est possible…',
    'Une seconde, je vérifie…',
  ],
};

export function progressMarkerText(agentId: string | undefined, seed: string | undefined): string {
  const variants =
    (agentId !== undefined ? PROGRESS_MARKER_VARIANTS[agentId] : undefined) ??
    PROGRESS_MARKER_VARIANTS.default!;
  return pickVariant(variants, seed);
}
