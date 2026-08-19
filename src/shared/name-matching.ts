/**
 * Rapprochement d'un NOM DE PERSONNE écrit par un humain avec les noms d'un annuaire.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le défaut que ce module comble, mesuré en production le 2026-08-13
 * ════════════════════════════════════════════════════════════════════════════
 *
 *   employee_id=d20df236…(Karyl)  type=welcome_letter  title="Bienvenue Awa"  status=sent
 *
 * Le document « Bienvenue Awa » a été enregistré sous l'UUID de Karyl, et l'email est
 * parti à l'adresse de Karyl. Awa a pourtant sa propre ligne `employees` — mais elle est
 * absente de `slack_directory`, et **aucun tool ne savait résoudre un prénom** :
 * `findEmployeeByEmail` exige une adresse que personne n'avait tapée. Sommé de fournir un
 * UUID, le modèle a réutilisé le seul de son contexte. `TODO.md` recensait ce manque
 * depuis le 2026-08-12 sans l'avoir relié au bug de destinataire.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi en TypeScript pur, dans `shared/`
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Deux features en ont besoin — `employee` (table `employees`) et `directory`
 * (`slack_directory`) — et aucune ne peut importer l'autre sans violer la règle de
 * dépendance. Le rapprochement doit donner le MÊME verdict des deux côtés : deux
 * implémentations divergeraient au premier accent, et une personne résolvable dans une
 * table cesserait de l'être dans l'autre sans qu'aucun type ne bouge.
 *
 * Et surtout : ce n'est PAS du SQL. `lower()` de SQLite ne retire pas les accents, et un
 * `LIKE '%needle%'` correspondrait au milieu des mots — « rao » retrouverait « Traoré ».
 * Sur une résolution de personne qui décide d'un destinataire d'email, une correspondance
 * approximative est exactement le défaut qu'on corrige.
 */

/**
 * Forme canonique d'un nom : sans accent, en minuscules, espaces normalisés.
 *
 * NFD puis retrait des marques combinantes (`\p{M}`) — jamais une table de
 * correspondance écrite à la main, qui oublierait toujours un caractère.
 *
 * ⚠️ On ne retire QUE les diacritiques. Un nom en cyrillique, en arabe ou en chinois
 * traverse intact : le réduire à la chaîne vide les rendrait tous équivalents entre eux,
 * donc tous « correspondants » — une résolution qui désignerait n'importe qui.
 */
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mots d'un nom, sous forme canonique.
 *
 * Le trait d'union est un SÉPARATEUR : « Frédéric-Noël » doit être atteignable par
 * « Noel » seul. Il est fréquent dans les noms composés français, et quelqu'un qui écrit
 * un prénom composé n'en tape presque jamais les deux moitiés.
 */
export function nameTokens(raw: string | null | undefined): string[] {
  const normalized = normalizeName(raw);
  if (!normalized) return [];
  return normalized.split(/[\s-]+/).filter((token) => token.length > 0);
}

/**
 * La requête désigne-t-elle cette personne ?
 *
 * `candidateFields` reçoit tout ce que la base connaît d'elle (prénom, nom, nom
 * d'affichage, nom réel) : les champs sont souvent partiellement vides — sur la
 * production du 2026-08-14, 22 lignes d'annuaire sur 40 n'ont pas de `last_name`.
 *
 * ── Les deux règles, et ce qu'elles écartent ────────────────────────────────
 *  1. **CHAQUE mot de la requête doit trouver preneur.** « Awa Diallo » ne résout donc
 *     pas « Awa TRAORE ». Sans cette règle, ajouter un nom de famille ÉLARGIRAIT la
 *     recherche au lieu de la restreindre — l'inverse de ce qu'attend celui qui le tape,
 *     et de nouveau un mauvais destinataire.
 *  2. **Correspondance par PRÉFIXE de mot, jamais par sous-chaîne.** « Trao » retrouve
 *     « Traoré » (on tape rarement un nom en entier), mais « rao » ne retrouve rien.
 *
 * Une requête vide rend `false` et non `true` : elle correspondrait sinon à tout le
 * monde, ce qui produirait une « ambiguïté » portant sur le workspace entier — bien pire
 * qu'un échec net, qui au moins instruit le modèle.
 */
export function matchesName(
  query: string | null | undefined,
  candidateFields: ReadonlyArray<string | null | undefined>,
): boolean {
  const queryTokens = nameTokens(query);
  if (queryTokens.length === 0) return false;

  const candidateTokens = candidateFields.flatMap((field) => nameTokens(field));
  if (candidateTokens.length === 0) return false;

  return queryTokens.every((wanted) =>
    candidateTokens.some((candidate) => candidate.startsWith(wanted)),
  );
}

/**
 * « Prénom Nom », proprement — ou une chaîne vide si l'on ne sait rien.
 *
 * ## Pourquoi une fonction pour trois mots
 *
 * Relevé le 2026-08-18 : le nom complet était construit à CINQ endroits, avec QUATRE
 * comportements différents. Ce n'est plus une duplication théorique, elle a déjà divergé :
 *
 *   `[a, b].filter(Boolean).join(' ').trim()`   → correct (document-template, handler)
 *   `` `${a ?? ''} ${b ?? ''}`.trim() ``        → **DOUBLE ESPACE** si le prénom manque
 *   `` `${a} ${b}`.trim() ``                    → imprime « undefined » si un champ est nul
 *   `… || '(sans nom)'`                         → repli propre à un seul appelant
 *
 * La deuxième forme vivait dans `find-expertise.ts`, dont le résultat est lu par un humain
 * (« Awa TRAORE — Backend Developer ») : un double espace y est visible.
 *
 * Ce fichier est le bon endroit — son en-tête dit déjà qu'il existe pour que le rapprochement
 * de noms soit « le même code des deux côtés ».
 *
 * ⚠️ Pas de repli « (sans nom) » ici : c'est une décision d'AFFICHAGE, et elle appartient à
 * l'appelant. `find-person-by-name` en a besoin pour lever une ambiguïté ; un document signé
 * ne doit surtout pas imprimer ça.
 */
export function fullName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string {
  return [firstName, lastName]
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

/**
 * Ce TEXTE nomme-t-il cette personne ?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi cette fonction existe, et pourquoi elle est ici
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le bloc DOCUMENTS impose au modèle de citer le `recipient` rendu par `generateDocument`.
 * C'est la mesure de VISIBILITÉ posée le 2026-08-14 contre l'erreur de destinataire — celle
 * qui a enregistré « Bienvenue Awa » sous l'UUID de Karyl et envoyé le fichier à son adresse.
 * Mesuré en production le 2026-08-19, sur DEUX sondes document : **le modèle ne le cite pas**.
 * La consigne ne se déclenche pas, donc la mesure ne mesure rien.
 *
 * Le handler accole donc la note lui-même — mais seulement si elle manque, sans quoi une
 * réponse déjà juste se verrait doubler d'une redite de machine. Il faut donc SAVOIR si elle
 * manque, et c'est ce que cette fonction répond.
 *
 * ⚠️ Le rapprochement est EXACT, pas par préfixe, contrairement à `matchesName`. Les deux
 * questions sont inverses : là, un humain TAPE un nom incomplet et l'on cherche qui il vise ;
 * ici, une machine a ÉCRIT le nom complet et l'on vérifie qu'il y est. Un préfixe rendrait
 * « Kar » suffisant, donc « carte » — non, « carte » ne commence pas par… si, justement :
 * `matchesName('kar', ['karyl'])` est vrai, et « ta carte » contiendrait donc « Karyl ».
 *
 * ⚠️ Les jetons de moins de 3 caractères sont écartés : « Li », « Bo », une initiale
 * apparaissent partout dans une phrase française et feraient conclure à tort que la personne
 * est nommée — le sens dangereux, celui qui SUPPRIME l'avertissement.
 *
 * ⚠️ Le découpage du texte se fait sur les non-lettres avec le drapeau `u`, jamais sur `\b`
 * (qui raisonne en ASCII, piège payé quatre fois dans ce dépôt) : sans quoi « pour Karyl. »
 * rendrait le jeton « karyl. », qui n'égale jamais « karyl ».
 */
export function textMentionsName(
  text: string | null | undefined,
  name: string | null | undefined,
): boolean {
  const wanted = nameTokens(name).filter((token) => token.length >= 3);
  if (wanted.length === 0) return false;

  const words = new Set(
    normalizeName(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );

  return wanted.some((token) => words.has(token));
}
