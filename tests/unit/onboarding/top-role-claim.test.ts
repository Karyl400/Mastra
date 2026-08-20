import { describe, it, expect } from 'vitest';

import {
  declaresTopRole,
  topRoleClaimNotice,
} from '../../../src/features/onboarding/domain/services/top-role-claim';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * QUELQU'UN SE DÉCLARE AU SOMMET — le dire au sommet
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ CE PRÉDICAT N'ACCORDE RIEN, et c'est ce qui rend acceptable qu'il repose sur une chaîne
 * saisie par la personne elle-même. Le seul fait qui ouvre la portée est
 * `slack_directory.role`, écrit hors du produit. Ici on produit un SIGNAL adressé à un humain.
 *
 * L'asymétrie fixe la largeur du filet : un faux positif coûte un DM lu en trois secondes, un
 * faux négatif laisse une déclaration au sommet passer inaperçue. Mais pas au point
 * d'attraper « Product Manager » — trois personnes sur six de ce workspace portent un titre
 * contenant « manager », et le filet se déclencherait à chaque arrivée.
 */

describe('declaresTopRole — le sommet, et rien d’autre', () => {
  it('reconnaît le poste, quelle que soit la casse ou l’accent', () => {
    // « Général Manager » avec l'accent est l'orthographe employée par le propriétaire
    // en formulant la demande — le cas réel avant le cas canonique.
    for (const position of ['Général Manager', 'general manager', 'GENERAL MANAGER']) {
      expect(declaresTopRole(position), position).toBe(true);
    }
  });

  it('reconnaît les formes françaises et les sigles', () => {
    for (const position of ['Directeur Général', 'Directrice Générale', 'CEO', 'PDG']) {
      expect(declaresTopRole(position), position).toBe(true);
    }
  });

  it('n’attrape PAS les métiers réels qui contiennent « manager »', () => {
    // Relevé en production : « Product Manager » est le titre de quelqu'un qui n'est pas LE
    // manager, et « manager » seul est trop courant. Sans cette exclusion, le signal partirait
    // à chaque arrivée et deviendrait du bruit — donc il s'ignorerait.
    for (const position of [
      'Product Manager',
      'Engineering Manager',
      'Manager',
      'Software Engineer',
      'Backend Developer',
    ]) {
      expect(declaresTopRole(position), position).toBe(false);
    }
  });

  it('exige la LOCUTION ENTIÈRE, jamais un fragment de mot', () => {
    // Sans ancrage, « ceo » capturerait n'importe quel mot le contenant. Ce dépôt a déjà payé
    // ce défaut trois fois : `\b` en ASCII, `includes('test')`, `endsWith(org)`.
    expect(declaresTopRole('Ceograph')).toBe(false);
    expect(declaresTopRole('Pdgroupe')).toBe(false);
    expect(declaresTopRole('CEO')).toBe(true);
  });

  it('ne se prononce pas sur une absence', () => {
    expect(declaresTopRole(undefined)).toBe(false);
    expect(declaresTopRole(null)).toBe(false);
    expect(declaresTopRole('   ')).toBe(false);
  });
});

describe('topRoleClaimNotice — ce que le manager reçoit', () => {
  const notice = topRoleClaimNotice({
    newcomerName: 'Awa TRAORE',
    declaredPosition: 'Général Manager',
    slackUserId: 'U0AWA',
  });

  it('nomme la personne et ce qu’elle a écrit', () => {
    expect(notice).toContain('Awa TRAORE');
    expect(notice).toContain('Général Manager');
  });

  it('DIT que rien n’a changé — sans quoi il se lirait comme une alerte de sécurité', () => {
    // Annoncer un danger qui n'existe pas est la même famille de mensonge que d'en taire un.
    // Un intitulé n'accorde aucun droit : la personne reste sur son seul dossier.
    expect(notice).toMatch(/n['’]accorde aucun droit/i);
    expect(notice).toMatch(/rien n['’]a changé/i);
  });

  it('nomme le geste EXACT à faire si la réponse est oui', () => {
    // Un message qui demande d'approuver sans dire comment laisse son destinataire chercher —
    // et c'est ainsi qu'une approbation n'arrive jamais.
    expect(notice).toContain('role:set');
    expect(notice).toContain('U0AWA');
  });

  it('ne PROMET rien sur le refus — il n’y a rien à défaire', () => {
    expect(notice).toMatch(/rien à défaire/i);
  });
});
