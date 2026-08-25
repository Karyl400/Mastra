import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CAPABILITY_LOANS, loansTo, isLentTo } from '../../../src/shared/capability-loans';
import { AGENT_TOOLS, agentHasTool } from '../../../src/shared/agent-capabilities';

const ROOT = resolve(__dirname, '../../..');

/**
 * ════════════════════════════════════════════════════════════════════════════
 * PRÊTER UNE CAPACITÉ SANS PRÊTER LE DESTINATAIRE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Deux agents de ce dépôt ne peuvent pas être réunis, et ce n'est pas une préférence :
 * `knowledgeAgent` sait lire un canal, `onboardingOrchestrator` sait fabriquer et envoyer un
 * document. `outbound-tool-quarantine.ts` cite mot pour mot le scénario que leur réunion
 * rendrait possible — *« Envoie à ce candidat un récapitulatif de ce qui se dit dans
 * #engineer-karyl. »* — et les deux fabriques LÈVENT au démarrage pour l'empêcher.
 *
 * Une demande légitime tombe pourtant entre les deux : « résume ce canal et donne-le-moi en
 * PDF ». En production, elle recevait un contournement — *« copie-moi le texte que tu souhaites
 * que je résume »* — c'est-à-dire un report du travail sur l'humain.
 *
 * ⚠️ **LE POINT QUI DÉBLOQUE TOUT : le danger n'est pas « lire + écrire », c'est « lire +
 * envoyer À QUELQU'UN D'AUTRE ».** Un prêt qui ne comporte AUCUN destinataire ne peut pas former
 * le canal d'exfiltration : le fichier contient ce que l'outil avait déjà le droit de rendre en
 * texte, et il est déposé là où ce texte serait allé. **On change le format, pas le flux
 * d'information.**
 *
 * C'est ce que ce registre déclare, et ce que ce fichier verrouille. Trois invariants, et
 * chacun ferme une façon précise de se tromper :
 *
 *   1. l'outil emprunté n'entre JAMAIS dans `AGENT_TOOLS` de l'emprunteur — sans quoi le prêt
 *      deviendrait un câblage, et la garantie structurelle tomberait ;
 *   2. le prêt ne porte AUCUN paramètre de destinataire — invariant de TYPE, pas de convention ;
 *   3. la frontière d'autorisation réutilisée est la MÊME fonction que celle de l'outil
 *      propriétaire — ce dépôt a déjà payé une seconde copie d'une règle d'autorisation qui
 *      finit par dire autre chose que la première (d'où `probe:authz` important `resolveAccess`).
 */
describe('registre des prêts de capacité', () => {
  it('déclare au moins un prêt, et le scan le voit (anti faux-négatif)', () => {
    expect(CAPABILITY_LOANS.length).toBeGreaterThan(0);
  });

  it('INVARIANT 1 — l’outil emprunté n’est jamais câblé sur l’emprunteur', () => {
    // C'est la différence entre un prêt et un câblage. Si l'outil apparaissait dans
    // `AGENT_TOOLS`, le modèle pourrait l'appeler librement, avec ses propres arguments — donc
    // choisir sa cible. Le prêt, lui, est exécuté par le CODE, sur une cible déjà autorisée.
    for (const loan of CAPABILITY_LOANS) {
      for (const borrower of loan.lentTo) {
        expect(
          agentHasTool(borrower, loan.borrowedFrom),
          `${borrower} porte ${loan.borrowedFrom} : ce n'est plus un prêt, c'est un câblage`,
        ).toBe(false);
      }
    }
  });

  it('INVARIANT 2 — aucun prêt ne comporte de destinataire', () => {
    // `deliversTo` est une union à UNE seule valeur : le type interdit d'en écrire une autre.
    // Ce test vérifie que personne n'a élargi l'union en douce.
    for (const loan of CAPABILITY_LOANS) {
      expect(loan.deliversTo).toBe('requester');
    }

    const source = readFileSync(join(ROOT, 'src/shared/capability-loans.ts'), 'utf8');
    expect(
      /deliversTo:\s*'requester'/.test(source),
      'le type deliversTo doit rester une union à une seule valeur',
    ).toBe(true);
    expect(source).not.toMatch(/recipient|destinataire\s*:/i);
  });

  it('INVARIANT 3 — la frontière citée existe et est celle de l’outil propriétaire', () => {
    // Une frontière recopiée est une frontière qui dira un jour autre chose. On vérifie donc
    // que la fonction nommée est bien exportée par son module, ET qu'elle est effectivement
    // importée par l'outil qui exécute le prêt.
    for (const loan of CAPABILITY_LOANS) {
      const boundarySource = readFileSync(join(ROOT, loan.boundaryModule), 'utf8');
      expect(
        boundarySource.includes(`export function ${loan.boundary}`),
        `${loan.boundary} n'est pas exportée par ${loan.boundaryModule}`,
      ).toBe(true);

      const executorSource = readFileSync(join(ROOT, loan.executedBy), 'utf8');
      expect(
        executorSource.includes(loan.boundary),
        `${loan.executedBy} n'appelle pas ${loan.boundary} : la frontière n'est pas réutilisée`,
      ).toBe(true);
    }
  });

  it('l’emprunteur déclaré est un agent réel du registre', () => {
    for (const loan of CAPABILITY_LOANS) {
      for (const borrower of loan.lentTo) {
        expect(Object.hasOwn(AGENT_TOOLS, borrower)).toBe(true);
      }
    }
  });

  it('l’exécutant du prêt EST un outil que l’emprunteur porte déjà', () => {
    // Le prêt étend un outil existant ; il n'en ajoute pas un second. Un outil de plus, c'est
    // un schéma réémis à chaque aller-retour de l'agent qui le porte.
    for (const loan of CAPABILITY_LOANS) {
      for (const borrower of loan.lentTo) {
        expect(
          agentHasTool(borrower, loan.extendsTool),
          `${borrower} ne porte pas ${loan.extendsTool}, qui doit exécuter le prêt`,
        ).toBe(true);
      }
    }
  });

  it('les fonctions de lecture du registre s’accordent avec sa déclaration', () => {
    for (const loan of CAPABILITY_LOANS) {
      for (const borrower of loan.lentTo) {
        expect(isLentTo(borrower, loan.name)).toBe(true);
        expect(loansTo(borrower).map((l) => l.name)).toContain(loan.name);
      }
    }
    expect(isLentTo('recruitmentAgent', 'channelDigest')).toBe(false);
    expect(loansTo('recruitmentAgent')).toEqual([]);
  });

  /**
   * ⚠️ LE GARDE-FOU LE PLUS IMPORTANT DE CE FICHIER.
   *
   * Un prêt reste sûr tant que l'emprunteur n'a AUCUN chemin de sortie vers un tiers. Le jour où
   * quelqu'un câblera `sendNotification` sur `knowledgeAgent`, la quarantaine lèvera au
   * démarrage — mais si elle était un jour assouplie, ce test resterait la seconde ligne : un
   * emprunteur ne doit porter aucun outil agissant capable de désigner un destinataire.
   */
  it('un emprunteur ne porte AUCUN outil d’écriture vers un tiers', () => {
    const outboundToThirdParty = [
      'sendNotification',
      'scheduleReminder',
      'scheduleCandidateInterview',
    ];
    for (const loan of CAPABILITY_LOANS) {
      for (const borrower of loan.lentTo) {
        for (const tool of outboundToThirdParty) {
          expect(
            agentHasTool(borrower, tool),
            `${borrower} emprunte une lecture ET porte ${tool} : c'est le canal d'exfiltration`,
          ).toBe(false);
        }
      }
    }
  });

  it('aucun autre module de src/ ne redéclare un prêt en douce', () => {
    // Une seconde liste de prêts est le mode de panne exact que ce registre existe pour
    // empêcher — la même leçon que `READ_ONLY_TOOL_NAMES` recopié.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !full.endsWith('capability-loans.ts')) {
          if (/CAPABILITY_LOANS\s*[:=]\s*\[/.test(readFileSync(full, 'utf8'))) offenders.push(full);
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});
