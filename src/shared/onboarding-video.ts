/**
 * La vidéo d'accueil pré-enregistrée, et le guide écrit qui l'accompagne.
 *
 * ## Où vit la vidéo, et pourquoi PAS dans le bundle de la fonction
 *
 * Le fichier est un actif STATIQUE (`public/onboarding/…`), recopié par
 * `scripts/fix-vercel-output.js` dans `.vercel/output/static/` — servi par le CDN Vercel,
 * **jamais** chargé par la fonction. C'est la propriété décisive : le poste de coût numéro un
 * de ce produit est le DÉMARRAGE À FROID (4,9 s mesurées le 2026-08-18, dominé par le
 * dépaquetage du bundle), et 7 Mio embarqués dans `index.func` l'auraient aggravé à chaque
 * invocation, pour un fichier lu quelques fois par mois.
 *
 * Contrepartie assumée et à connaître : **l'URL n'est protégée par aucune authentification**.
 * C'est un tutoriel de remplissage de formulaire, pas une donnée RH ; l'alternative — un
 * permalien Slack — dépend d'un fichier que n'importe qui peut supprimer, et un lien mort dans
 * le premier message de l'entreprise à un arrivant est le défaut que ce module existe pour
 * éviter.
 *
 * ## Pourquoi l'URL est DÉRIVÉE, et pas seulement configurée
 *
 * `ONBOARDING_VIDEO_URL` restait à poser à la main sur Vercel, en plus de livrer le fichier :
 * deux choses qui doivent s'accorder, donc deux choses qui finissent par diverger. Comme
 * l'actif est servi par notre PROPRE déploiement, son URL se déduit du domaine de production
 * (`VERCEL_PROJECT_PRODUCTION_URL`, exposée d'office par Vercel aux fonctions). La variable
 * reste acceptée et PRIME — c'est ce qui permet d'héberger la vidéo ailleurs sans toucher au
 * code — mais elle n'est plus nécessaire.
 *
 * ⚠️ Le pendant de cette dérivation vit dans `fix-vercel-output.js` : le build **ÉCHOUE** si
 * l'actif manque. Sans ce contrôle, supprimer le fichier ne casserait rien de visible et
 * produirait un 404 dans le message d'accueil.
 *
 * ## Pourquoi la lecture n'est pas mise en cache
 *
 * `process.env` est lu à chaque appel, comme partout ailleurs dans ce dépôt : il n'y a aucune
 * validation centralisée de l'environnement (`src/config/` a été supprimé), et figer la
 * valeur au chargement du module obligerait à redéployer pour poser l'URL, alors qu'une
 * variable Vercel prend effet au redémarrage suivant.
 */

/**
 * Le chemin de l'actif, à la fois dans `public/` et dans l'URL servie.
 *
 * ⚠️ Nom en ASCII pur, alors que le fichier d'origine s'appelait
 * `tuto_complétion_de_profil.mp4`. Un accent dans une URL doit être percent-encodé, et ce
 * chemin traverse trois écritures (le disque, le CDN, un lien Slack) qui n'encodent pas
 * toutes de la même façon. Même règle que `document-file.ts`, qui dérive un nom de fichier par
 * liste blanche `[a-z0-9]` après décomposition NFD.
 */
export const ONBOARDING_VIDEO_PATH = '/onboarding/tuto-completion-de-profil.mp4';

/**
 * La durée annoncée dans le message.
 *
 * ⚠️ Elle a été VÉRIFIÉE sur le fichier (54 s), pas supposée. La rédaction précédente
 * promettait « deux minutes » sur une vidéo qui n'existait pas encore : c'est exactement le
 * genre d'affirmation invérifiable que ce dépôt traque, et elle se serait retrouvée fausse.
 */
const VIDEO_DURATION_LABEL = 'moins d’une minute, tout y est';

/** L'URL déduite du déploiement lui-même, quand il en sert une. */
function deployedVideoUrl(): string | undefined {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!host) return undefined;
  return `https://${host}${ONBOARDING_VIDEO_PATH}`;
}

/**
 * L'URL de la vidéo, ou `undefined`.
 *
 * ⚠️ Seuls `https://` et `http://` sont acceptés. La valeur finit dans un message Slack, donc
 * dans un lien cliquable : un `javascript:` ou un `data:` y serait un vecteur, et une valeur
 * mal collée (un chemin, un identifiant nu) produirait un lien mort — les deux se traitent au
 * même endroit, en refusant tout ce qui n'est pas une URL web. La valeur DÉRIVÉE passe par le
 * même filtre : un `VERCEL_PROJECT_PRODUCTION_URL` inattendu ne doit pas contourner la garde.
 */
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

/**
 * La ligne qui renvoie vers la vidéo — VIDE quand il n'y en a pas.
 *
 * Même forme que `channelsLine` : c'est la phrase entière qui disparaît, jamais un lien
 * remplacé par « (à venir) » ou « N/A ».
 */
export function videoLine(): string {
  const url = onboardingVideoUrl();
  if (!url) return '';
  return `\n\n*1.* Regarde d'abord la vidéo d'accueil : <${url}|${VIDEO_DURATION_LABEL}>.`;
}

/**
 * Le GUIDE ÉCRIT — ce que la personne doit préparer avant de dire que c'est fait.
 *
 * ⚠️ Il énumère exactement les champs du formulaire, et c'est le fond du parcours : la
 * personne sait ce qu'on va lui demander AVANT de l'ouvrir, donc elle ne le referme pas pour
 * aller chercher son adresse pro. Le formulaire n'est plus une porte d'entrée, c'est la
 * dernière étape d'un chemin annoncé.
 *
 * Numérotation continue avec `videoLine()` : la vidéo est l'étape 1 quand elle existe, et le
 * guide commence alors à 2. Sans vidéo, il commence à 1 — pas de trou dans la liste, qui
 * signalerait à l'arrivant qu'on lui cache une étape.
 */
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
