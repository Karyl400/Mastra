import { describe, it, expect } from 'vitest';

import { buildDocumentOutline } from '../../../src/features/document/domain/services/document-template';
import { DocumentType } from '../../../src/shared/types';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * UN DOCUMENT DIT À QUI IL S'ADRESSE — demandé le 2026-08-20
 * ════════════════════════════════════════════════════════════════════════════
 *
 * « Dans les documents rédigés (PDF, email), le contenu du document doit préciser à qui il
 * s'adresse. »
 *
 * Le contrat portait déjà « Employé : … » et la lettre ouvrait sur « Bonjour … ». Le GUIDE —
 * le document le plus produit du système — et le gabarit GÉNÉRIQUE — celui qui sert dans la
 * moitié des cas — ne nommaient personne : ils commençaient par leur titre.
 *
 * Ce n'est pas qu'une question de forme. Un fichier circule : il est uploadé dans Slack,
 * parfois envoyé en pièce jointe, et il est repartageable. Le 2026-08-13, les dix documents de
 * la base portaient le même UUID et un « Bienvenue Awa » avait été livré à quelqu'un d'autre —
 * personne ne l'a vu, parce que rien dans le fichier ne disait pour qui il avait été fait. La
 * note accolée à la réponse Slack (`buildRecipientNotice`) ne suit pas le fichier ; cette
 * ligne-ci, si.
 */

const employee = {
  firstName: 'Karyl',
  lastName: 'SOUMAILA',
  email: 'karylsoumaila1@gmail.com',
  position: 'Software Engineer',
};

const render = (type: DocumentType, over: Record<string, unknown> = {}) =>
  JSON.stringify(
    buildDocumentOutline({
      type,
      title: 'Guide de démarrage',
      content: 'Contenu rédigé par le modèle.',
      employee,
      ...over,
    }),
  );

describe('chaque document nomme la personne qu’il concerne', () => {
  it('le GUIDE, qui ne nommait personne', () => {
    expect(render(DocumentType.Guide)).toContain('Document destiné à Karyl SOUMAILA');
  });

  it('le gabarit GÉNÉRIQUE, qui sert dans la moitié des cas', () => {
    // `DocumentType` compte neuf valeurs et quatre gabarits dédiés : tout le reste tombe ici.
    expect(render(DocumentType.Policy)).toContain('Document destiné à Karyl SOUMAILA');
  });

  it('le CONTRAT et la LETTRE le faisaient déjà — non-régression', () => {
    expect(render(DocumentType.Contract)).toContain('Karyl SOUMAILA');
    expect(render(DocumentType.WelcomeLetter)).toContain('Bonjour Karyl SOUMAILA');
  });
});

describe('ce qu’un document ne dit PAS de la personne', () => {
  it('la phrase DISPARAÎT quand le nom est inconnu — jamais « destiné à  »', () => {
    // Règle constante des gabarits : un champ absent fait disparaître sa phrase. C'est elle
    // qui a fait retirer « en tant que N/A » d'une lettre signée de l'entreprise.
    const sansNom = render(DocumentType.Guide, { employee: { position: 'Software Engineer' } });

    expect(sansNom).not.toContain('destiné à');
  });

  it('le NOM, jamais l’email ni le département', () => {
    // Un document est repartageable : y imprimer une adresse en ferait un vecteur de
    // diffusion de donnée personnelle. Et « les départements ne doivent plus apparaître ».
    const guide = render(DocumentType.Guide, {
      employee: { ...employee, department: 'Engineering' },
    });

    expect(guide).toContain('Karyl SOUMAILA');
    expect(guide).not.toContain('karylsoumaila1@gmail.com');
    expect(guide).not.toContain('Engineering');
  });
});
