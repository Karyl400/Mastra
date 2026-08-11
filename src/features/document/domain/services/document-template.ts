import { DocumentType } from '../../../../shared/types';
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
 * Découpe le corps libre en paragraphes.
 *
 * Le `content` vient d'un LLM : il arrive avec des lignes vides, des retours
 * simples, parfois des `\r\n`. Le coller en un seul bloc produisait un pavé
 * illisible ; on sépare sur les lignes vides, et à défaut sur les retours simples
 * (un modèle qui n'a produit aucune ligne vide a quand même structuré son texte).
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

function fullName(input: DocumentRenderInput): string {
  const { firstName, lastName } = input.employee ?? {};
  return [firstName, lastName].filter(Boolean).join(' ').trim();
}

function titleOf(input: DocumentRenderInput): string {
  const provided = (input.title ?? '').trim();
  return provided.length > 0 ? provided : DEFAULT_TITLES[input.type];
}

/** Blocs du corps libre, ajoutés à la fin de chaque template. */
function bodyBlocks(input: DocumentRenderInput): DocumentBlock[] {
  return splitParagraphs(input.content).map((text) => ({ kind: 'paragraph', text }) as const);
}

function buildContract(input: DocumentRenderInput): DocumentBlock[] {
  const employee = input.employee ?? {};
  return [
    { kind: 'heading', text: COMPANY, level: 1 },
    { kind: 'heading', text: titleOf(input), level: 2 },
    {
      kind: 'fields',
      rows: [
        ['Employé', fullName(input)],
        ['Email', employee.email ?? ''],
        ['Département', employee.department ?? ''],
        ['Poste', employee.position ?? ''],
      ],
    },
    ...bodyBlocks(input),
  ];
}

function buildWelcomeLetter(input: DocumentRenderInput): DocumentBlock[] {
  const employee = input.employee ?? {};
  return [
    { kind: 'heading', text: COMPANY, level: 1 },
    { kind: 'heading', text: titleOf(input), level: 2 },
    { kind: 'paragraph', text: `Cher(e) ${fullName(input)},` },
    {
      kind: 'paragraph',
      text:
        `Nous avons le plaisir de vous accueillir au sein de Kisso Industries, ` +
        `département ${employee.department ?? 'N/A'}, en tant que ${employee.position ?? 'N/A'}.`,
    },
    {
      kind: 'paragraph',
      text: `Votre date de début est le ${employee.startDate ?? 'à confirmer'}.`,
    },
    { kind: 'heading', text: 'Prochaines étapes', level: 2 },
    {
      kind: 'bullets',
      items: [
        'Compléter votre profil employé',
        'Rejoindre les canaux Slack assignés',
        'Remplir le questionnaire d’intégration',
        'Consulter le guide onboarding',
      ],
    },
    ...bodyBlocks(input),
    { kind: 'paragraph', text: 'Bienvenue dans l’équipe !', italic: true },
  ];
}

function buildCertificate(input: DocumentRenderInput): DocumentBlock[] {
  return [
    { kind: 'heading', text: titleOf(input), level: 1 },
    {
      kind: 'paragraph',
      text: `${fullName(input)} a complété son onboarding chez Kisso Industries.`,
    },
    ...bodyBlocks(input),
  ];
}

function buildGuide(input: DocumentRenderInput): DocumentBlock[] {
  const employee = input.employee ?? {};
  return [
    { kind: 'heading', text: titleOf(input), level: 1 },
    { kind: 'paragraph', text: `Département : ${employee.department ?? 'Général'}` },
    {
      kind: 'bullets',
      items: [
        'Configuration poste de travail',
        'Accès Slack/GitHub',
        'Présentation équipe',
        'Culture entreprise',
      ],
    },
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

/** Modèle logique du document, quel que soit le format de sortie visé. */
export function buildDocumentOutline(input: DocumentRenderInput): DocumentOutline {
  const template = TEMPLATES[input.type] ?? buildGeneric;
  return { title: titleOf(input), blocks: template(input) };
}
