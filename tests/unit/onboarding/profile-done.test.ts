import { describe, it, expect } from 'vitest';

import { claimsProfileDone } from '../../../src/shared/profile-done';

/**
 * ⚠️ CE PRÉDICAT EXISTE PARCE QU'UN TEXTE LE PROMETTAIT.
 *
 * Le guide d'accueil dit, mot pour mot : « Reviens ici et clique sur "C'est fait" — ou
 * écris-moi simplement "j'ai fini" ». Tant qu'il n'existait pas, cette phrase était une
 * promesse creuse : la personne suivait l'instruction écrite et son message partait chez un
 * agent qui n'a aucune idée de ce qu'elle vient d'accomplir.
 *
 * C'est le défaut que ce dépôt traque partout ailleurs — l'email de bienvenue a perdu
 * « vous recevrez prochainement les accès », `scheduleReminder` a cessé de dire
 * « planifié », et la ligne sur la vidéo disparaît tant qu'aucune URL n'est configurée.
 */

describe('« j’ai fini » — les formes qu’un humain écrit vraiment', () => {
  it.each([
    "c'est fait",
    'C’est fait !',
    "j'ai fini",
    'J’ai terminé',
    'j’ai rempli le formulaire',
    'voilà, c’est fini',
    'fait',
    'Terminé !',
    'dossier complété',
  ])('« %s »', (text) => {
    expect(claimsProfileDone(text)).toBe(true);
  });
});

describe('ce qui ne doit PAS déclencher', () => {
  it('la NÉGATION, qui dit exactement le contraire', () => {
    // Sans cette garde, « je n'ai pas fini » commence par une formule de la liste une fois
    // la phrase normalisée. C'est le même piège, en plus bénin, que celui qui faisait
    // effacer les données de quelqu'un demandant le contraire — reproduit par une revue
    // adversariale sur `forget.ts`.
    for (const text of ["je n'ai pas fini", 'j’ai pas encore fini', "ce n'est pas fait"]) {
      expect(claimsProfileDone(text), text).toBe(false);
    }
  });

  it('une INTENTION, qui n’est pas un achèvement', () => {
    for (const text of ['je vais le faire', 'bientôt fini', 'je finis ce soir']) {
      expect(claimsProfileDone(text), text).toBe(false);
    }
  });

  it('une phrase LONGUE, qui parle forcément d’autre chose', () => {
    // La borne est le vrai discriminant. « c'est fait » est une phrase entière ; « c'est
    // fait, mais j'ai un souci avec le canal #signals et je voulais aussi te demander… »
    // est une conversation, et y répondre par une vérification de dossier serait à côté.
    expect(
      claimsProfileDone(
        "c'est fait, mais j'ai un souci avec le canal signals et je voulais te demander autre chose",
      ),
    ).toBe(false);
  });

  it('un accusé de réception, qui accompagne n’importe quoi', () => {
    for (const text of ['ok', 'voilà', 'merci', 'bien reçu', '👍']) {
      expect(claimsProfileDone(text), text).toBe(false);
    }
  });

  it('le vide et l’absence', () => {
    expect(claimsProfileDone('')).toBe(false);
    expect(claimsProfileDone(undefined)).toBe(false);
    expect(claimsProfileDone(null)).toBe(false);
  });
});
