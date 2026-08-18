import { DocumentType } from '../../../../shared/types';
import { sanitizeDocumentText } from '../../../../shared/security/agent-output';
import { formatFrenchDay } from '../../../../shared/french-date';
import { fullName } from '../../../../shared/name-matching';
import type { DocumentRenderInput } from '../ports/document-renderer';

/**
 * Modèle logique d'un document, indépendant du format de sortie.
 *
 * POURQUOI CETTE COUCHE. Les templates existaient en dur dans le service pdfmake,
 * sous forme de `TDocumentDefinitions`. Dupliquer cette logique pour DOCX aurait
 * garanti la dérive : deux rendus du même type de document auraient fini par ne
 * plus dire la même chose. Ici, chaque renderer traduit la MÊME liste de blocs
 * dans sa propre grammaire — le choix du format est un choix de rendu, jamais de
 * contenu.
 *
 * Les blocs sont volontairement pauvres (titre, paragraphe, puces, champs) :
 * c'est le dénominateur commun que PDF et DOCX savent tous deux rendre sans
 * approximation.
 */

export type DocumentBlock =
  | { kind: 'heading'; text: string; level: 1 | 2 }
  | { kind: 'paragraph'; text: string; italic?: boolean }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'fields'; rows: ReadonlyArray<readonly [string, string]> };

export interface DocumentOutline {
  title: string;
  blocks: DocumentBlock[];
}

const COMPANY = 'KISSO INDUSTRIES';

/** Titre de repli par type, quand l'appelant n'en fournit pas (cas de `generate()`). */
export const DEFAULT_TITLES: Record<DocumentType, string> = {
  [DocumentType.Contract]: 'Contrat de travail',
  [DocumentType.Amendment]: 'Avenant au contrat',
  [DocumentType.WelcomeLetter]: 'Lettre de bienvenue',
  [DocumentType.Guide]: 'Guide d’onboarding',
  [DocumentType.Certificate]: 'Certificat d’onboarding',
  [DocumentType.Policy]: 'Politique interne',
  [DocumentType.TaxForm]: 'Document fiscal',
  [DocumentType.IDDocument]: 'Pièce d’identité',
  [DocumentType.Other]: 'Document',
};

/**
 * Traduction du markdown produit par le LLM vers le modèle logique.
 *
 * AVANT : le corps libre était simplement découpé en paragraphes, donc `**`,
 * `#`, `---` et `|` s'imprimaient LITTÉRALEMENT dans le PDF livré — et
 * `splitParagraphs` faisait même de `---` un paragraphe à lui seul. Le modèle
 * écrit du markdown quoi qu'on lui demande (la consigne « pas de markdown » a
 * été démentie en production, sur les trois agents) : le seul recours est de le
 * traduire.
 *
 * On TRADUIT plutôt qu'on ne RETIRE, parce que les blocs cibles existent déjà et
 * sont rendus à l'identique par les deux renderers : un `#` devient un titre, un
 * `- ` une puce, un tableau à deux colonnes un bloc `fields`. Retirer le
 * balisage aurait aplati toute la structure en un pavé, ce qui est le défaut
 * d'origine sous une autre forme. Ce qui n'a pas d'équivalent (séparateur
 * horizontal, barres résiduelles, emphase en ligne) est retiré au seuil du rendu
 * par `sanitizeDocumentText`.
 */

// L'indentation de tête est BORNÉE à 8 caractères dans tous ces motifs. Un `[ \t]*`
// non borné rend le moteur quadratique sur une ligne entièrement blanche — et ces
// motifs s'appliquent ligne à ligne à une sortie de LLM de taille non bornée.
// Pas d'ancre `$` finale non plus : appliqués à UNE ligne, `(.*)` va déjà jusqu'au
// bout, et l'ancre n'ajoutait qu'une source de retour arrière.

/** `# Titre` … `###### Titre`. Le niveau markdown ne survit pas : voir plus bas. */
const HEADING_LINE = /^[ \t]{0,8}(#{1,6})[ \t]+(.*)/;
/** `- item`, `* item`, `+ item`, `1. item`, `2) item`. */
const BULLET_LINE = /^[ \t]{0,8}(?:[-*+]|\d{1,3}[.)])[ \t]+(.*)/;
/** `---`, `***`, `___` — séparateur horizontal, sans équivalent dans un document. */
const HORIZONTAL_RULE = /^[ \t]{0,8}([-*_])\1{2,}[ \t]{0,8}$/;
/** Ligne de tableau markdown : elle commence par une barre. */
const TABLE_LINE = /^[ \t]{0,8}\|/;
/** Clôture de bloc de code : le balisage part, le contenu reste du texte. */
const CODE_FENCE = /^[ \t]{0,8}```/;

/**
 * Ligne d'alignement d'un tableau (`|---|:--:|`) : structurelle, jamais rendue.
 *
 * Balayage caractère par caractère plutôt qu'une regex `[…]+$`, qui serait
 * super-linéaire par retour arrière sur une longue ligne de tirets.
 */
function isTableDivider(row: string): boolean {
  const trimmed = row.trim();
  return trimmed.length > 0 && [...trimmed].every((char) => '|:- \t'.includes(char));
}

/** Cellules d'une ligne de tableau markdown, barres de bord retirées. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Traduit un groupe de lignes de tableau.
 *
 * Deux colonnes → bloc `fields`, la forme que PDF et DOCX rendent tous deux
 * proprement. Toute autre largeur → des puces, une ligne par entrée : un tableau
 * à cinq colonnes rendu en `fields` mentirait sur les données en n'en gardant
 * que deux.
 */
function tableBlocks(rows: string[]): DocumentBlock[] {
  const cells = rows
    .filter((row) => !isTableDivider(row))
    .map(tableCells)
    .filter((row) => row.some((cell) => cell.length > 0));

  if (cells.length === 0) return [];

  if (cells.every((row) => row.length === 2)) {
    return [{ kind: 'fields', rows: cells.map((row) => [row[0] ?? '', row[1] ?? ''] as const) }];
  }

  return [{ kind: 'bullets', items: cells.map((row) => row.join(' — ')) }];
}

/**
 * Découpe le corps libre en paragraphes.
 *
 * Le `content` vient d'un LLM : il arrive avec des lignes vides, des retours
 * simples, parfois des `\r\n`. Le coller en un seul bloc produisait un pavé
 * illisible ; on sépare sur les lignes vides, et à défaut sur les retours simples
 * (un modèle qui n'a produit aucune ligne vide a quand même structuré son texte).
 *
 * Conservé et exporté : c'est le repli de {@link parseContentBlocks} pour tout ce
 * qui n'est pas du balisage — un texte sans markdown traverse donc exactement le
 * même chemin qu'avant.
 */
export function splitParagraphs(content: string): string[] {
  const normalized = (content ?? '').replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) return [];

  const separator = normalized.includes('\n\n') ? /\n{2,}/ : /\n/;

  return normalized
    .split(separator)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * Corps libre → blocs. Analyse ligne à ligne, coût linéaire.
 *
 * Les titres du corps sont TOUS de niveau 2, quel que soit le nombre de `#` :
 * le niveau 1 est déjà pris par le titre du document, et un `#` produit par le
 * modèle au milieu d'un corps ne prétend pas rivaliser avec lui.
 */
export function parseContentBlocks(content: string): DocumentBlock[] {
  const lines = (content ?? '').replace(/\r\n?/g, '\n').split('\n');

  const blocks: DocumentBlock[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let table: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    for (const text of splitParagraphs(paragraph.join('\n')))
      blocks.push({ kind: 'paragraph', text });
    paragraph = [];
  };
  const flushBullets = () => {
    if (bullets.length === 0) return;
    blocks.push({ kind: 'bullets', items: bullets });
    bullets = [];
  };
  const flushTable = () => {
    if (table.length === 0) return;
    blocks.push(...tableBlocks(table));
    table = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushBullets();
    flushTable();
  };

  for (const line of lines) {
    if (CODE_FENCE.test(line) || HORIZONTAL_RULE.test(line)) {
      flushAll();
      continue;
    }

    if (line.trim().length === 0) {
      flushAll();
      continue;
    }

    if (TABLE_LINE.test(line)) {
      flushParagraph();
      flushBullets();
      table.push(line);
      continue;
    }
    flushTable();

    const heading = HEADING_LINE.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ kind: 'heading', text: heading[2] ?? '', level: 2 });
      continue;
    }

    const bullet = BULLET_LINE.exec(line);
    if (bullet) {
      flushParagraph();
      bullets.push(bullet[1] ?? '');
      continue;
    }
    flushBullets();

    paragraph.push(line);
  }

  flushAll();
  return blocks;
}

/** Le nom de la personne concernée par le document. Voir `shared/name-matching.ts`. */
function recipientName(input: DocumentRenderInput): string {
  const { firstName, lastName } = input.employee ?? {};
  return fullName(firstName, lastName);
}

function titleOf(input: DocumentRenderInput): string {
  const provided = (input.title ?? '').trim();
  return provided.length > 0 ? provided : DEFAULT_TITLES[input.type];
}

/** Blocs du corps libre, ajoutés à la fin de chaque template. */
function bodyBlocks(input: DocumentRenderInput): DocumentBlock[] {
  return parseContentBlocks(input.content);
}

function buildContract(input: DocumentRenderInput): DocumentBlock[] {
  const employee = input.employee ?? {};
  return [
    { kind: 'heading', text: COMPANY, level: 1 },
    { kind: 'heading', text: titleOf(input), level: 2 },
    {
      kind: 'fields',
      // La ligne « Département » n'apparaît QUE si la valeur existe. Depuis le 2026-08-13
      // le département n'est plus collecté : une ligne vide dans un contrat signé de
      // l'entreprise se lit comme un champ qu'on a oublié de remplir, pas comme un champ
      // qu'on a cessé de demander.
      rows: [
        ['Employé', recipientName(input)],
        ['Email', employee.email ?? ''],
        ...(employee.department ? [['Département', employee.department] as const] : []),
        ['Poste', employee.position ?? ''],
      ].map((row) => [row[0], row[1]] as [string, string]),
    },
    ...bodyBlocks(input),
  ];
}

function buildWelcomeLetter(input: DocumentRenderInput): DocumentBlock[] {
  const employee = input.employee ?? {};
  // Extrait de la phrase : un ternaire dans un littéral déjà interpolé se relit mal, et c'est
  // exactement la ligne qu'il faut pouvoir vérifier d'un coup d'œil.
  const departmentClause = employee.department ? `, département ${employee.department},` : '';

  // ⚠️ Le POSTE suit désormais la même règle que le département, et il ne la suivait pas :
  // `employee.position ?? 'N/A'` produisait « en tant que N/A » dans une lettre signée de
  // l'entreprise et adressée à un arrivant — exactement ce que le commentaire d'à côté
  // condamnait, deux lignes plus bas. `welcome-email.ts` avait déjà corrigé ce défaut :
  // un champ absent fait disparaître sa phrase, jamais apparaître un « N/A ».
  const positionClause = employee.position ? ` en tant que ${employee.position}` : '';

  // ⚠️ La date était imprimée BRUTE : « ta date de début est le 2026-09-01T00:00:00.000Z ».
  // Troisième écriture d'un formatage de date dans ce dépôt, et la seule fausse — d'où
  // `shared/french-date.ts`, qui la rend une bonne fois.
  const startDay = formatFrenchDay(employee.startDate);

  return [
    { kind: 'heading', text: COMPANY, level: 1 },
    { kind: 'heading', text: titleOf(input), level: 2 },
    // ⚠️ TUTOIEMENT, comme partout ailleurs. Cette lettre vouvoyait (« Cher(e) », « Votre
    // date ») alors que le guide produit par le MÊME bot, pour la MÊME personne, dit « Ton
    // quotidien » et « Ta façon de travailler ». Un salarié qui reçoit les deux voit deux
    // expéditeurs. L'exception reste `interview-email.ts`, qui vouvoie un candidat EXTERNE —
    // un candidat n'est pas un collègue.
    { kind: 'paragraph', text: `Bonjour ${recipientName(input)},` },
    {
      kind: 'paragraph',
      // Le département n'est cité que s'il est connu. « département N/A » dans une lettre de
      // bienvenue est pire qu'un silence : c'est un aveu de trou, adressé à l'arrivant.
      text: `Ravis de t'accueillir chez Kisso Industries${departmentClause}${positionClause}.`,
    },
    // La phrase entière disparaît quand la date est inconnue — plutôt qu'un « à confirmer »
    // qui promet une confirmation que personne n'enverra.
    ...(startDay
      ? [{ kind: 'paragraph' as const, text: `Ton premier jour est le ${startDay}.` }]
      : []),
    // ⚠️ Le bloc « Prochaines étapes » a été RETIRÉ le 2026-08-14, et ce n'est pas une
    // simplification : il MENTAIT. Ses quatre puces étaient écrites en dur, donc
    // identiques pour tout le monde, et deux d'entre elles renvoyaient à des choses qui
    // n'existent pas — « Remplir le questionnaire d'intégration » (aucun questionnaire
    // n'est envoyable ni remplissable, cf. `generate-questionnaire.ts`) et « Consulter le
    // guide onboarding » (aucune URL de téléchargement n'existe dans ce système).
    // « Rejoindre les canaux Slack assignés » est parti avec le suivi de tâches.
    //
    // Ce qui reste est ce que le dossier sait RÉELLEMENT — y compris, depuis le 2026-08-14,
    // ce que la personne a dit d'elle à l'entretien — plus le corps rédigé par le modèle.
    // Une lettre plus courte et vraie vaut mieux qu'une liste qui donne des instructions
    // impossibles à un arrivant.
    ...interviewBlocks(input),
    ...bodyBlocks(input),
    { kind: 'paragraph', text: 'Bienvenue dans l’équipe !', italic: true },
  ];
}

function buildCertificate(input: DocumentRenderInput): DocumentBlock[] {
  return [
    { kind: 'heading', text: titleOf(input), level: 1 },
    {
      kind: 'paragraph',
      text: `${recipientName(input)} a complété son onboarding chez Kisso Industries.`,
    },
    ...bodyBlocks(input),
  ];
}

/**
 * Ce que la personne a dit d'elle à l'entretien post-profil, rendu en blocs.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi c'est le GABARIT qui l'imprime, et non le modèle
 * ════════════════════════════════════════════════════════════════════════════
 *
 * L'alternative était d'exposer l'entretien au modèle pour qu'il en tire une prose. Écartée
 * pour trois raisons, dont la dernière suffirait :
 *
 *  1. **Coût.** Il faudrait soit un tool de plus (schéma repayé à CHAQUE aller-retour de
 *     chaque message, sur un budget de ≈ 19 messages/jour), soit ces textes dans la fenêtre
 *     du modèle. Ici : zéro token.
 *  2. **Fidélité.** Le modèle reformulerait. Ce que la personne a écrit sur elle-même n'a pas
 *     à être réécrit par une machine dans un document qui porte son nom.
 *  3. **Vérité.** Un gabarit ne peut pas halluciner. C'est la même raison qui fait imprimer
 *     `position` ici plutôt que d'espérer que le modèle le recopie.
 *
 * Le `content` rédigé par le modèle vient s'AJOUTER à ces blocs, il ne les remplace pas : la
 * chaleur vient de la prose, la véracité du gabarit.
 *
 * ⚠️ Chaque section n'est émise que si son champ existe. Les trois champs de l'entretien sont
 * facultatifs, et un intertitre suivi du vide se lit comme un oubli — le défaut exact qui a
 * fait retirer « Département : N/A » de la lettre de bienvenue.
 */
function interviewBlocks(input: DocumentRenderInput): DocumentBlock[] {
  const interview = input.interview;
  if (!interview) return [];

  const blocks: DocumentBlock[] = [];

  const dailyWork = (interview.dailyWork ?? '').trim();
  if (dailyWork.length > 0) {
    blocks.push(
      { kind: 'heading', text: 'Ton quotidien', level: 2 },
      { kind: 'paragraph', text: dailyWork },
    );
  }

  const workStyle = (interview.workStyle ?? '').trim();
  if (workStyle.length > 0) {
    blocks.push(
      { kind: 'heading', text: 'Ta façon de travailler', level: 2 },
      { kind: 'paragraph', text: workStyle },
    );
  }

  const channels = (interview.channels ?? []).filter((name) => name.trim().length > 0);
  if (channels.length > 0) {
    blocks.push(
      { kind: 'heading', text: 'Tes canaux', level: 2 },
      // Le `#` est rendu ICI et non stocké : c'est une convention d'AFFICHAGE Slack, et la
      // base garde les identifiants `C…`, qui ne se lisent pas.
      { kind: 'bullets', items: channels.map((name) => `#${name}`) },
    );
  }

  return blocks;
}

function buildGuide(input: DocumentRenderInput): DocumentBlock[] {
  const employee = input.employee ?? {};
  return [
    { kind: 'heading', text: titleOf(input), level: 1 },
    // Idem : pas de ligne « Département : Général », qui inventait une appartenance.
    ...(employee.department
      ? [{ kind: 'paragraph' as const, text: `Département : ${employee.department}` }]
      : []),
    // Le poste, lui, est TOUJOURS connu (`employees.position` est `NOT NULL`) et il est la
    // seule chose qui distingue le guide d'une personne de celui d'une autre. L'écrire ici
    // évite que le modèle ait à le recopier dans `content` — et qu'il l'oublie.
    ...(employee.position
      ? [{ kind: 'paragraph' as const, text: `Poste : ${employee.position}` }]
      : []),
    // ⚠️ Les quatre puces « Configuration poste de travail / Accès Slack-GitHub /
    // Présentation équipe / Culture entreprise » ont été RETIRÉES le 2026-08-14. Écrites en
    // dur, elles sortaient à l'identique dans le guide de CHAQUE personne, quel que soit son
    // poste, et ne renvoyaient à aucune procédure existante : c'est exactement le
    // « document générique » signalé par le propriétaire.
    //
    // Le contenu utile vient de DEUX sources, dans cet ordre : ce que la personne a dit
    // d'elle à l'entretien (matière réelle, imprimée telle quelle), puis la prose du modèle.
    // Un gabarit ne doit porter que ce que le CODE sait — le reste, il l'invente.
    ...interviewBlocks(input),
    ...bodyBlocks(input),
  ];
}

/**
 * Template GÉNÉRIQUE : titre + corps libre.
 *
 * Indispensable, et non un simple filet : `generateDocument` expose les NEUF
 * valeurs de `DocumentType` au modèle, alors que quatre seulement ont un template
 * dédié. Sans ce repli, une demande d'avenant, de politique interne ou de
 * document « other » échouerait au rendu — c'est-à-dire dans la moitié des cas.
 * C'est de surcroît le cas d'usage NORMAL : quand un agent rédige lui-même un
 * document, tout le contenu est dans `content` et aucun gabarit n'a de sens.
 */
function buildGeneric(input: DocumentRenderInput): DocumentBlock[] {
  const body = bodyBlocks(input);
  return [
    { kind: 'heading', text: titleOf(input), level: 1 },
    ...(body.length > 0 ? body : [{ kind: 'paragraph' as const, text: '' }]),
  ];
}

const TEMPLATES: Partial<Record<DocumentType, (input: DocumentRenderInput) => DocumentBlock[]>> = {
  [DocumentType.Contract]: buildContract,
  [DocumentType.WelcomeLetter]: buildWelcomeLetter,
  [DocumentType.Certificate]: buildCertificate,
  [DocumentType.Guide]: buildGuide,
};

/** Texte feuille assaini. Seule la valeur est retenue ici — voir le commentaire
 * de `buildDocumentOutline` pour la journalisation, qui appartient à l'appelant. */
function clean(text: string): string {
  return sanitizeDocumentText(text).text;
}

/**
 * Assainit un bloc, ou le laisse tomber s'il ne reste rien à rendre.
 *
 * Un bloc vidé par l'assainissement (un paragraphe qui n'était qu'un emoji, une
 * puce qui n'était qu'un lien fabriqué) doit disparaître : le garder produirait
 * une ligne vide ou une puce sans texte, c'est-à-dire une trace visible du
 * filtrage dans un document signé de l'entreprise.
 */
function sanitizeBlock(block: DocumentBlock): DocumentBlock | undefined {
  switch (block.kind) {
    // `heading` et `paragraph` partagent le traitement : un seul champ textuel,
    // et le reste du bloc (`level`, `italic`) est reconduit tel quel.
    case 'heading':
    case 'paragraph': {
      const text = clean(block.text);
      return text.length > 0 ? { ...block, text } : undefined;
    }
    case 'bullets': {
      const items = block.items.map(clean).filter((item) => item.length > 0);
      return items.length > 0 ? { kind: 'bullets', items } : undefined;
    }
    case 'fields': {
      const rows = block.rows.map((row) => [clean(row[0]), clean(row[1])] as const);
      return rows.length > 0 ? { kind: 'fields', rows } : undefined;
    }
  }
}

/**
 * Modèle logique du document, quel que soit le format de sortie visé.
 *
 * ⚠️ **C'est ici que passe l'assainissement du contenu, et c'est délibéré.**
 * Le seuil du rendu est le SEUL point qu'aucun chemin ne contourne : les deux
 * renderers (`PdfmakeService.render`, `DocxService.render`) l'appellent, et
 * `PdfmakeService.generate()` — le chemin historique de
 * `documentGenerationWorkflow`, qui ne passe PAS par le tool `generateDocument`
 * — l'appelle aussi. Assainir uniquement dans le tool aurait laissé le workflow
 * dehors ; assainir uniquement ici aurait laissé la PERSISTANCE dehors, puisque
 * c'est le tool qui écrit en base. Les deux le font donc, et l'opération est
 * idempotente (voir `sanitizeDocumentText`).
 *
 * Aucune journalisation ici : la couche `domain` ne dépend de rien. Le signal
 * remonte à l'appelant, qui journalise en `error` — exactement comme le handler
 * Slack le fait pour `sanitizeAgentOutput`.
 */
export function buildDocumentOutline(input: DocumentRenderInput): DocumentOutline {
  const template = TEMPLATES[input.type] ?? buildGeneric;

  const blocks = template(input)
    .map(sanitizeBlock)
    .filter((block): block is DocumentBlock => block !== undefined);

  const title = clean(titleOf(input));

  return {
    title: title.length > 0 ? title : DEFAULT_TITLES[input.type],
    // pdfmake refuse un `content` vide : on garantit au moins un bloc.
    blocks: blocks.length > 0 ? blocks : [{ kind: 'paragraph', text: '' }],
  };
}
