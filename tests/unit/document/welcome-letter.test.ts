import { describe, it, expect } from 'vitest';

import { buildDocumentOutline } from '../../../src/features/document/domain/services/document-template';
import { DocumentType } from '../../../src/shared/types';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * La lettre de bienvenue — le premier document signé que reçoit un arrivant
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Trois défauts y coexistaient le 2026-08-18, et AUCUN test ne les couvrait — c'est ce qui
 * leur a permis de survivre :
 *
 *  1. **« en tant que N/A »** quand le poste est inconnu. Le commentaire d'à côté condamnait
 *     pourtant explicitement « département N/A » comme « un aveu de trou, adressé à
 *     l'arrivant » : la règle existait, elle n'avait pas été appliquée au champ voisin.
 *     `welcome-email.ts` la respectait déjà — un champ absent y fait disparaître sa phrase.
 *  2. **La date imprimée BRUTE** : « Votre date de début est le 2026-09-01T00:00:00.000Z ».
 *     Troisième écriture d'un formatage de date dans ce dépôt, et la seule fausse.
 *  3. **Le vouvoiement**, alors que le guide produit par le MÊME bot pour la MÊME personne
 *     dit « Ton quotidien », « Ta façon de travailler ». Un salarié qui reçoit les deux voit
 *     deux expéditeurs — et le basculement de registre est un défaut déjà rencontré ici, sur
 *     `NEUTRAL_REFUSAL`.
 */

const base = {
  id: 'd36b78dc-a039-4160-b86a-bd3d2a722b6c',
  firstName: 'Awa',
  lastName: 'TRAORE',
  email: 'awa.traore@kisso.com',
};

const letter = (employee: Record<string, unknown>): string =>
  buildDocumentOutline({
    type: DocumentType.WelcomeLetter,
    title: 'Bienvenue',
    content: 'Contenu rédigé par le modèle.',
    employee: employee as never,
  })
    .blocks.map((block) => ('text' in block ? block.text : JSON.stringify(block)))
    .join('\n');

describe('lettre de bienvenue — elle ne dit que ce qu’elle sait', () => {
  it('n’écrit JAMAIS « N/A » — le champ absent fait disparaître sa mention', () => {
    const text = letter({ ...base, position: null, department: null, startDate: null });

    expect(text).not.toContain('N/A');
    expect(text).not.toMatch(/en tant que\s*\./);
  });

  it('cite le poste — et JAMAIS le département, même connu', () => {
    // ⚠️ INVERSION du 2026-08-20 : « les départements ne doivent plus apparaître ». Le champ
    // a quitté `DocumentRenderInput`, d'où le `as never` — ce test vérifie qu'une valeur
    // résiduelle en base ne peut pas se frayer un chemin jusqu'à une lettre signée de
    // l'entreprise.
    const text = letter({
      ...base,
      position: 'Backend Developer',
      department: 'Engineering',
      startDate: null,
    } as never);

    expect(text).toContain('Backend Developer');
    expect(text).not.toContain('Engineering');
  });

  it('écrit la date en français, jamais en ISO', () => {
    const text = letter({ ...base, startDate: '2026-09-01T00:00:00.000Z' });

    expect(text).toContain('septembre');
    // La forme exacte dépend de l'ICU du runtime ; ce qui compte est qu'aucun horodatage
    // machine n'atteigne le lecteur.
    expect(text).not.toContain('2026-09-01T');
    expect(text).not.toContain('00:00:00');
  });

  it('OMET la phrase de date plutôt que d’annoncer « à confirmer »', () => {
    // « à confirmer » promet une confirmation que personne n'enverra — il n'existe ni cron
    // ni relance dans ce système. Même famille que `scheduleReminder`, qui a appris à ne
    // plus dire « planifié ».
    const text = letter({ ...base, startDate: null });

    expect(text).not.toContain('à confirmer');
    expect(text).not.toContain('premier jour');
  });

  it('TUTOIE, comme le guide produit par le même bot pour la même personne', () => {
    const text = letter({ ...base, position: 'Backend Developer', startDate: null });

    expect(text).not.toContain('Cher(e)');
    expect(text).not.toMatch(/\bVotre\b/);
    expect(text).not.toMatch(/\bvous accueillir\b/);
    expect(text).toMatch(/\bt'accueillir\b/);
  });
});
