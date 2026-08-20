import { describe, it, expect } from 'vitest';
import { EmployeeRole, isManagerRole } from '../../../src/shared/types';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE SEUL FAIT QUI ACCORDE — et sa lecture doit pencher du bon côté
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `slack_directory.role` est la seule colonne de ce dépôt dont dépende une autorisation. Ce
 * qui compte ici n'est pas qu'elle reconnaisse `manager` — c'est que RIEN D'AUTRE ne soit
 * reconnu comme tel. Une colonne corrompue, une valeur écrite par une version future, un
 * `NULL` sur une ligne antérieure à la migration : aucun de ces cas ne doit ACCORDER quoi que
 * ce soit.
 *
 * Même arbitrage que `readSlackContext`, où un niveau d'accès inconnu est ignoré plutôt
 * qu'interprété : le défaut sûr est celui qui ne donne rien.
 */

describe('isManagerRole — la lecture tolérante d’un fait d’autorisation', () => {
  it('reconnaît le rôle manager', () => {
    expect(isManagerRole(EmployeeRole.Manager)).toBe(true);
    expect(isManagerRole('manager')).toBe(true);
  });

  it('n’accorde RIEN sur une absence', () => {
    // La colonne naît vide sur toute base antérieure au DDL, et `LEFT JOIN` rend `null`.
    expect(isManagerRole(null)).toBe(false);
    expect(isManagerRole(undefined)).toBe(false);
    expect(isManagerRole('')).toBe(false);
  });

  it('n’accorde RIEN sur une valeur inconnue ou approchante', () => {
    // ⚠️ Aucune tolérance de casse ni d'espaces, à dessein. Un `trim().toLowerCase()` ferait
    // passer une valeur écrite de travers pour une désignation valide, alors que l'écriture
    // est faite par un script à liste FERMÉE : une valeur qui n'est pas exactement `manager`
    // n'a pas été posée par le chemin prévu, et il n'y a aucune raison de lui faire confiance.
    for (const raw of ['Manager', 'MANAGER', ' manager ', 'managers', 'admin', 'owner', 'true']) {
      expect(isManagerRole(raw)).toBe(false);
    }
  });

  it('n’accorde RIEN sur un TITRE — un intitulé n’est pas un droit', () => {
    // Relevé en production : « General Manager » et « Product Manager » sont des titres Slack,
    // édités par leur porteur. Le second appartient à quelqu'un qui n'est PAS le manager. Si
    // cette fonction les reconnaissait, l'autorisation s'obtiendrait en éditant son profil.
    expect(isManagerRole('General Manager')).toBe(false);
    expect(isManagerRole('Product Manager')).toBe(false);
  });

  it('le DÉFAUT de la colonne n’accorde rien', () => {
    expect(isManagerRole(EmployeeRole.Employee)).toBe(false);
  });
});
