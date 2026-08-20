import { describe, it, expect } from 'vitest';

import {
  sanitizeAgentOutput,
  sanitizeDocumentSource,
} from '../../../src/shared/security/agent-output';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « EMAIL PROFESSIONNEL » DEVANT UNE ADRESSE GMAIL
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Rendu en production, dans une fiche relue par sa propriétaire. Le tool ne rend que `email` :
 * le mot « professionnel » est une affirmation SANS DONNÉE. Le produit ne sait pas si une
 * adresse est professionnelle — il accepte les deux, à dessein, parce que l'exiger
 * professionnelle était une impasse sans sortie (corrigée le 2026-08-19).
 *
 * ⚠️ TROISIÈME CORRECTION du même défaut, et les deux premières enseignent :
 *
 *   1. Neuf descriptions d'outils disaient « l'email professionnel ». Toutes retirées.
 *      **Vérifié en production : le modèle a continué.**
 *   2. Une clause ajoutée à la règle anti-invention — « ne qualifie pas ce qu'il rend ».
 *      **Vérifié en production : le modèle a continué.**
 *
 * Même verdict que pour la couverture des extraits, la rédaction du contenu et la citation du
 * destinataire : une consigne est PROBABLE, le code est GARANTI. Les deux premières corrections
 * RESTENT — elles réduisent la fréquence et ne coûtent rien de plus — mais elles ne closent
 * rien, et il ne faut pas faire semblant du contraire.
 */

describe('le qualificatif que le produit ne peut pas savoir vrai', () => {
  it('retire « professionnel » accolé à un email', () => {
    expect(sanitizeAgentOutput('Email professionnel : a@b.com').text).toBe('Email : a@b.com');
  });

  it('couvre les formes réellement écrites : pluriel, féminin, abrégé', () => {
    for (const [avant, apres] of [
      ['email pro : a@b.com', 'email : a@b.com'],
      ['Adresse email professionnelle : a@b.com', 'Adresse email : a@b.com'],
      ['E-mail professionnel : a@b.com', 'E-mail : a@b.com'],
    ] as const) {
      expect(sanitizeAgentOutput(avant).text, avant).toBe(apres);
    }
  });

  it('retire le QUALIFICATIF, jamais la phrase', () => {
    // Contraire du choix fait pour un marqueur interne : là, la réponse entière est suspecte ;
    // ici, elle est juste à un mot près. Jeter un profil correct pour un adjectif serait sans
    // commune mesure avec le défaut.
    const rendu = sanitizeAgentOutput('Prénom : Karyl\nEmail professionnel : a@b.com').text;

    expect(rendu).toContain('Prénom : Karyl');
    expect(rendu).toContain('a@b.com');
  });

  it('n’attrape PAS les usages légitimes du mot', () => {
    // Le retrait est ANCRÉ sur « email » / « adresse » : ailleurs, « professionnel » est un
    // mot ordinaire, et l'effacer partout mutilerait des phrases justes.
    for (const phrase of [
      'Il est très professionnel dans son travail',
      'Un profil professionnel soigné',
      'parcours professionnel',
    ]) {
      expect(sanitizeAgentOutput(phrase).text, phrase).toBe(phrase);
    }
  });

  it('vaut AUSSI pour le contenu des documents', () => {
    // Un document est PIRE que la réponse : téléchargeable, repartageable, et il porte le nom
    // de la personne. Une affirmation sans donnée y survit bien plus longtemps.
    expect(sanitizeDocumentSource('Email professionnel : a@b.com').text).toBe('Email : a@b.com');
  });
});
