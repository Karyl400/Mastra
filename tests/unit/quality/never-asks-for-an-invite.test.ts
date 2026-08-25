import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * MARCEL NE DEMANDE JAMAIS QU'ON L'INVITE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Verdict du propriétaire, 2026-08-25 : *« ne demande jamais à un utilisateur d'inviter
 * Marcel »*.
 *
 * La phrase venait de NOUS. `VERDICT_HINTS.bot_not_in_channel` valait littéralement
 * « Invite-moi dans ce canal pour que je puisse le lire », et le modèle l'a fidèlement
 * recopiée : *« Je n'ai pas accès au canal "institute". Invite-moi dans ce canal… »*
 *
 * ⚠️ **C'EST LA MÊME FAMILLE QUE `not_channel_member` LA VEILLE.** Ce champ n'est pas un
 * message d'erreur, c'est un TEXTE QUI SORT — un `hint` traverse le modèle presque tel quel
 * quand il est déjà rédigé à la première personne. Un impératif écrit dans un `hint` est un
 * impératif prononcé.
 *
 * ⚠️ **CE QUE CE TEST PROUVE, ET CE QU'IL NE PROUVE PAS.** Il prouve que le dépôt ne SÈME
 * plus la formule ; un modèle reste libre de l'inventer. La garantie est partielle et il faut
 * le dire — mais la mesure de production montre que le modèle recopiait, il n'inventait pas.
 */

const ROOT = resolve(__dirname, '../../..');
const SRC = join(ROOT, 'src');

/**
 * Les formules interdites ont toutes la même forme : un impératif (ou un infinitif de demande)
 * dont l'OBJET est le bot. « invite la personne à te redemander » ne matche pas — l'objet y est
 * la personne, et c'est une formule légitime.
 */
const FORBIDDEN: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'invite-moi', pattern: /\binvite[zs]?[- ]m(?:oi|'y|’y)\b/iu },
  { label: 'ajoute-moi', pattern: /\bajoute[zs]?[- ]m(?:oi|'y|’y)\b/iu },
  { label: "m'inviter", pattern: /\bm(?:'|’)(?:y )?inviter\b/iu },
  { label: "m'ajouter", pattern: /\bm(?:'|’)(?:y )?ajouter\b/iu },
  { label: 'inviter le bot', pattern: /\binvite[zr]?\s+(?:le\s+bot|marcel)\b/iu },
];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

describe('aucun texte de `src/` ne demande une invitation pour Marcel', () => {
  const files = sourceFiles(SRC);

  it('trouve bien des fichiers à examiner', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const { label, pattern } of FORBIDDEN) {
    it(`ne dit jamais « ${label} »`, () => {
      const offenders = files
        .filter((file) => pattern.test(readFileSync(file, 'utf-8')))
        .map((file) => relative(ROOT, file));

      expect(offenders).toEqual([]);
    });
  }
});

describe('les motifs reconnaissent ce qu’ils interdisent', () => {
  /**
   * ⚠️ Sans cette moitié, le test ci-dessus serait vert et vide de sens — même précaution que
   * `assistant-persona.test.ts`, pour la même raison.
   */
  const CAUGHT = [
    'Invite-moi dans ce canal pour que je puisse le lire.',
    'Invitez-moi et je pourrai lire ce canal.',
    'Il faudrait m’y inviter.',
    'Tu peux m’ajouter au canal ?',
    'Ajoute-moi à ce canal.',
    'Demande à un admin d’inviter le bot.',
  ];

  const SPARED = [
    'invite la personne à te redemander dans un message séparé',
    "je n'ai pas pu t'ajouter à tes canaux Slack",
    'Newcomer invited to the welcome channels',
    'inviteToChannel(channelId, userId)',
  ];

  it.each(CAUGHT)('attrape « %s »', (phrase) => {
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(phrase))).toBe(true);
  });

  it.each(SPARED)('épargne « %s »', (phrase) => {
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(phrase))).toBe(false);
  });
});
