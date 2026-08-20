export const ONBOARDING_VIDEO_PATH = '/onboarding/tuto-completion-de-profil.mp4';

const VIDEO_DURATION_LABEL = 'moins d’une minute, tout y est';

function deployedVideoUrl(): string | undefined {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!host) return undefined;
  return `https://${host}${ONBOARDING_VIDEO_PATH}`;
}

export function onboardingVideoUrl(): string | undefined {
  const raw = process.env.ONBOARDING_VIDEO_URL?.trim() || deployedVideoUrl();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function videoLine(): string {
  const url = onboardingVideoUrl();
  if (!url) return '';
  return `\n\n*1.* Regarde d'abord la vidéo d'accueil : <${url}|${VIDEO_DURATION_LABEL}>.`;
}

export function writtenGuide(): string {
  const step = onboardingVideoUrl() ? 2 : 1;
  return (
    `\n\n*${step}.* Prépare trois choses :\n` +
    '  • ton nom et ton prénom\n' +
    '  • ton adresse email — celle de l’entreprise ou ta personnelle\n' +
    '  • l’intitulé de ton poste\n\n' +
    `*${step + 1}.* Reviens ici et écris-moi simplement « j’ai fini ».`
  );
}
