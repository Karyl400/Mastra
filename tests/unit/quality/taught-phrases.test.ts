import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claimsProfileDone } from '../../../src/shared/profile-done';
import { requestsProfileForm } from '../../../src/shared/profile-request';
import { skipsInterview } from '../../../src/features/onboarding/domain/services/interview-chat';
import { readsAsNo, readsAsYes } from '../../../src/shared/confirmation';
import { requestsErasure } from '../../../src/shared/forget';
import { requestsReminderCancellation } from '../../../src/shared/cancel-reminder';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * UNE PHRASE QU'ON APPREND À TAPER DOIT ÊTRE RECONNUE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ce dépôt a déjà payé cette faute une fois, et le commentaire est encore dans le code : le
 * guide d'accueil disait « ou écris-moi simplement "j'ai fini" » alors qu'aucun prédicat ne
 * reconnaissait cette phrase. La personne qui suivait l'instruction écrite voyait son message
 * partir chez un agent qui n'avait aucune idée de ce qu'elle venait d'accomplir.
 *
 * C'est la famille de la PROMESSE CREUSE, sous sa forme la plus vicieuse : le texte est vrai
 * au moment où il est écrit, et devient faux quand le prédicat change — sans que rien ne
 * rougisse, puisque les deux bords restent corrects séparément.
 *
 * ⚠️ Ce test EXTRAIT les phrases des textes réels plutôt que de les recopier. Une liste
 * recopiée se périme au premier changement de formulation, c'est-à-dire exactement quand elle
 * devrait servir — la leçon d'`agentToolBoundary` et de `agent-capabilities.ts`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../../src');

/** Tous les prédicats qui reconnaissent une phrase tapée par un humain. */
const RECOGNISERS: ReadonlyArray<(text: string) => unknown> = [
  claimsProfileDone,
  (t) => requestsProfileForm(t),
  skipsInterview,
  readsAsYes,
  readsAsNo,
  (t) => requestsErasure(t),
  (t) => requestsReminderCancellation(t),
];

function isRecognised(phrase: string): boolean {
  return RECOGNISERS.some((predicate) => Boolean(predicate(phrase)));
}

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, acc);
    else if (full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/**
 * Les phrases que le produit APPREND à taper.
 *
 * Le motif cherche un verbe d'instruction suivi d'une phrase entre guillemets français, dans
 * une CHAÎNE de code — jamais dans un commentaire, qui documente souvent l'inverse (« cette
 * phrase n'est plus reconnue »). Les lignes commençant par `*` ou `//` sont donc écartées.
 */
/**
 * ⚠️ La capture est le guillemet le plus INTERNE — `[^«»]` exclut les DEUX délimiteurs.
 *
 * Les guillemets sont imbriqués dans le produit : « Réponds EXACTEMENT : « Dis-moi « oui » ou
 * « non ». » ». Un motif qui capture jusqu'au premier `»` rend « Dis-moi « oui », qui n'est la
 * phrase de personne. La paire interne, elle, EST par définition ce qu'on demande de taper.
 *
 * La distance entre le verbe et la phrase est bornée à 80 caractères : sans borne, un verbe en
 * début de module ferait « enseigner » tous les guillemets du fichier.
 */
const TAUGHT_PHRASE =
  /(?:écris-moi|réécris-moi|redis-moi|dis-moi|réponds)[^»]{0,80}?«\s*([^«»]{2,40}?)\s*»/giu;

function taughtPhrases(): { phrase: string; file: string }[] {
  const found: { phrase: string; file: string }[] = [];

  for (const file of collectTsFiles(SRC)) {
    // ⚠️ Les COMMENTAIRES sont retirés ligne par ligne, puis les lignes de CODE sont
    // recollées. Les deux moitiés comptent : un commentaire documente souvent l'inverse de ce
    // que le code fait (« cette phrase n'est plus reconnue »), et une chaîne concaténée coupe
    // les phrases en deux — c'est le cas de `PROFILE_CHAT_SAVE_FAILED`, dont le verbe et la
    // phrase vivent sur deux lignes. Une analyse strictement ligne à ligne la manquait, donc
    // ce garde-fou passait au vert sur le défaut même qu'il cherche.
    const code = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join(' ');

    // Une phrase enseignée est un guillemet le plus INTERNE, précédé quelque part du même
    // énoncé par un verbe d'instruction. On borne la distance : sans elle, un verbe en début
    // de fichier ferait « enseigner » tous les guillemets du module.
    for (const match of code.matchAll(TAUGHT_PHRASE)) {
      // Le gras mrkdwn (`*« … »*`) et la ponctuation collée ne font pas partie de la phrase.
      const phrase = match[1]!.replace(/^\*+|\*+$/g, '').trim();
      if (phrase) found.push({ phrase, file: path.relative(SRC, file) });
    }
  }

  return found;
}

describe('les phrases que le produit apprend à taper', () => {
  it('en trouve — sinon ce test ne vérifierait rien', () => {
    // Garde-fou du garde-fou : un motif qui ne matche plus rien passerait au vert en
    // silence, ce qui est le mode d'échec de tous les tests dérivés d'une analyse de texte.
    expect(taughtPhrases().length).toBeGreaterThanOrEqual(4);
  });

  it('sont TOUTES reconnues par un prédicat', () => {
    const orphelines = taughtPhrases().filter(({ phrase }) => !isRecognised(phrase));

    expect(
      orphelines,
      `phrase(s) enseignée(s) que rien ne reconnaît : ${orphelines
        .map((o) => `« ${o.phrase} » (${o.file})`)
        .join(', ')}`,
    ).toEqual([]);
  });
});

describe('le produit n’enseigne pas TROIS phrases pour la même chose', () => {
  it('la complétion du dossier se demande d’une seule façon', () => {
    // ⚠️ Constat du 2026-08-19 : « j'ai fini » dans le guide d'accueil et dans la reprise
    // d'entretien, « c'est fait » dans l'échec d'enregistrement, « compléter mon profil » dans
    // deux autres textes. Toutes sont reconnues — ce n'est donc pas un bug — mais un produit
    // qui apprend trois formules pour un même geste se lit comme trois produits.
    //
    // La formule retenue est celle du propriétaire : « j'ai fini ». Les autres restent
    // RECONNUES (on n'a jamais intérêt à cesser de comprendre quelqu'un) ; ce qui est
    // verrouillé, c'est ce qu'on ENSEIGNE.
    const enseignees = taughtPhrases()
      .map((t) => t.phrase.toLowerCase())
      .filter((p) => claimsProfileDone(p));

    expect(enseignees.length).toBeGreaterThan(0);
    expect(
      new Set(enseignees).size,
      `formules enseignées : ${[...new Set(enseignees)].join(' / ')}`,
    ).toBe(1);
  });
});
