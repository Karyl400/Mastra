import { describe, it, expect } from 'vitest';

import { normalizeName, nameTokens, matchesName } from '../../../src/shared/name-matching';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi ce module existe — le défaut mesuré en production le 2026-08-13
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Relevé sur la Turso de production :
 *
 *   employee_id=d20df236…(Karyl)  type=welcome_letter  title="Bienvenue Awa"  status=sent
 *
 * Le document « Bienvenue Awa » porte l'UUID de KARYL, et l'email est parti à l'adresse
 * de Karyl. Awa a pourtant sa propre ligne `employees` — mais elle est absente de
 * `slack_directory`, et AUCUN tool ne savait résoudre un PRÉNOM : `findEmployeeByEmail`
 * exige une adresse que personne n'avait tapée.
 *
 * Le modèle a donc fait ce que ce dépôt sait qu'il fait dans un espace vide : il a
 * réutilisé le seul UUID présent dans son contexte. Ce module est la brique manquante.
 */

describe('normalizeName', () => {
  it('retire les accents, la casse et les espaces superflus', () => {
    expect(normalizeName('  Mistourath  IDI ')).toBe('mistourath idi');
    expect(normalizeName('Aïcha')).toBe('aicha');
    expect(normalizeName('Frédéric-Noël')).toBe('frederic-noel');
  });

  it('ne casse pas sur une entrée vide ou absente', () => {
    expect(normalizeName('')).toBe('');
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
  });

  it('traite un nom non latin sans le vider', () => {
    // Un workspace peut porter des noms en cyrillique ou en arabe. Les réduire à la
    // chaîne vide les rendrait tous équivalents, donc tous « correspondants ».
    expect(normalizeName('Пaмела')).not.toBe('');
    expect(normalizeName('مريم')).not.toBe('');
  });
});

describe('nameTokens', () => {
  it('découpe sur les espaces ET les traits d union', () => {
    expect(nameTokens('Frédéric-Noël Le Gall')).toEqual(['frederic', 'noel', 'le', 'gall']);
  });

  it('écarte les fragments vides', () => {
    expect(nameTokens('  Awa   TRAORE  ')).toEqual(['awa', 'traore']);
  });
});

describe('matchesName', () => {
  const awa = ['Awa', 'TRAORE', 'Awa TRAORE'];
  const karyl = ['Karyl', 'SOUMAILA', 'Karyl SOUMAILA'];

  it('reconnaît un prénom seul', () => {
    expect(matchesName('Awa', awa)).toBe(true);
    expect(matchesName('awa', awa)).toBe(true);
  });

  it('reconnaît un nom complet, dans les deux ordres', () => {
    expect(matchesName('Awa Traore', awa)).toBe(true);
    expect(matchesName('Traore Awa', awa)).toBe(true);
  });

  it('accepte un préfixe — on tape rarement le nom en entier', () => {
    expect(matchesName('Trao', awa)).toBe(true);
    expect(matchesName('Kar', karyl)).toBe(true);
  });

  it('EXIGE que chaque mot de la requête trouve preneur', () => {
    // « Awa Diallo » ne doit pas résoudre Awa TRAORE : c'est exactement le genre de
    // correspondance approximative qui a envoyé le document au mauvais destinataire.
    expect(matchesName('Awa Diallo', awa)).toBe(false);
  });

  it('ne correspond PAS sur un fragment en milieu de mot', () => {
    // « rao » à l'intérieur de « traore ». Un `includes` nu ferait correspondre
    // n'importe quelle personne dont le nom contient les mêmes lettres.
    expect(matchesName('rao', awa)).toBe(false);
  });

  it('ne correspond pas entre deux personnes distinctes', () => {
    expect(matchesName('Karyl', awa)).toBe(false);
    expect(matchesName('Awa', karyl)).toBe(false);
  });

  it('refuse une requête vide plutôt que de tout faire correspondre', () => {
    // Une requête vide qui correspondrait à tout le monde produirait une liste
    // « ambiguë » de tout le workspace, ce qui est pire qu'un échec net.
    expect(matchesName('', awa)).toBe(false);
    expect(matchesName('   ', awa)).toBe(false);
  });

  it('ignore les champs absents sans lever', () => {
    expect(matchesName('Nazer', ['Nazer', null, undefined, ''])).toBe(true);
  });

  it('est insensible aux accents des DEUX côtés', () => {
    expect(matchesName('Frederic', ['Frédéric', 'Dupont'])).toBe(true);
    expect(matchesName('Frédéric', ['Frederic', 'Dupont'])).toBe(true);
  });
});
