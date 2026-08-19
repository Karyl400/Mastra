/**
 * La vidéo d'accueil pré-enregistrée, et le guide écrit qui l'accompagne.
 *
 * ## Pourquoi une variable d'environnement, et pas une URL en dur
 *
 * Ce dépôt a une règle qu'il applique partout : **on ne promet jamais ce qu'aucun mécanisme
 * ne tient**. `ONBOARDING_WELCOME_CHANNELS` fait déjà disparaître la phrase « Je t'ai ajouté
 * à … » quand aucun canal n'est configuré ; l'email de bienvenue a perdu « vous recevrez
 * prochainement les accès à nos outils » parce qu'il n'existe ni provisioning ni planning ;
 * `scheduleReminder` a cessé de dire « planifié ».
 *
 * Une URL de vidéo écrite en dur avant que la vidéo n'existe serait la même faute, en pire :
 * c'est le PREMIER message qu'un arrivant reçoit de l'entreprise, et un lien mort y dit
 * « personne n'a vérifié ». Tant que `ONBOARDING_VIDEO_URL` n'est pas posée, la phrase
 * n'apparaît pas — le reste du guide se suffit à lui-même.
 *
 * ## Pourquoi la lecture n'est pas mise en cache
 *
 * `process.env` est lu à chaque appel, comme partout ailleurs dans ce dépôt : il n'y a aucune
 * validation centralisée de l'environnement (`src/config/` a été supprimé), et figer la
 * valeur au chargement du module obligerait à redéployer pour poser l'URL, alors qu'une
 * variable Vercel prend effet au redémarrage suivant.
 */

/**
 * L'URL de la vidéo, ou `undefined`.
 *
 * ⚠️ Seuls `https://` et `http://` sont acceptés. La valeur finit dans un message Slack, donc
 * dans un lien cliquable : un `javascript:` ou un `data:` y serait un vecteur, et une valeur
 * mal collée (un chemin, un identifiant nu) produirait un lien mort — les deux se traitent au
 * même endroit, en refusant tout ce qui n'est pas une URL web.
 */
export function onboardingVideoUrl(): string | undefined {
  const raw = process.env.ONBOARDING_VIDEO_URL?.trim();
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
  return `\n\n*1.* Regarde d'abord la vidéo d'accueil : <${url}|deux minutes, tout y est>.`;
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
    `\n\n*${step}.* Prépare trois choses, tu les as déjà :\n` +
    '  • ton nom et ton prénom\n' +
    '  • ton adresse email professionnelle\n' +
    '  • l’intitulé de ton poste\n\n' +
    `*${step + 1}.* Reviens ici et clique sur « C’est fait » — ou écris-moi simplement « j’ai fini ».`
  );
}
