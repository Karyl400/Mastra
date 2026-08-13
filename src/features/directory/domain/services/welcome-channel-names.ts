/**
 * Noms de canaux d'accueil, lus d'une variable d'environnement.
 *
 * Des NOMS et non des identifiants `C…` : c'est ce qu'un humain sait écrire et relire dans un
 * fichier de configuration, et c'est ce qu'il relira six mois plus tard sans avoir à ouvrir
 * Slack pour savoir de quel canal il parle. La résolution nom → identifiant est faite en
 * `application`, contre ce que Slack affirme au moment de l'invitation — jamais figée ici.
 *
 * ⚠️ TypeScript pur — aucun import.
 */
export function parseWelcomeChannelNames(raw: string | undefined | null): readonly string[] {
  // Un `Set` plutôt qu'un tableau filtré : il donne la déduplication ET conserve l'ordre
  // d'insertion. Deux invitations dans le même canal ne casseraient rien (la seconde rendrait
  // `already_in_channel`, comptée comme un succès), mais elles dépenseraient un appel Slack
  // et feraient apparaître le canal deux fois dans le message de bienvenue.
  const seen = new Set<string>();

  for (const part of (raw ?? '').split(',')) {
    // Le `#` de tête est retiré : c'est la forme sous laquelle Slack AFFICHE un canal, donc
    // celle qu'un humain recopiera. L'API, elle, ne connaît que le nom nu.
    const name = part.trim().replace(/^#+/, '').trim().toLowerCase();
    if (name) seen.add(name);
  }

  return Array.from(seen);
}
