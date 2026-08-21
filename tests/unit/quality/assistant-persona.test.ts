import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ASSISTANT_NAME,
  MACHINE_SELF_DESIGNATIONS,
  namesItselfAsMachine,
} from '../../../src/shared/assistant-identity';
import { AGENT_STYLE_BLOCK } from '../../../src/shared/agent-style';
import { GREETING_REPLIES, GREETING_REPLY } from '../../../src/shared/greeting';
import { buildWelcomeBlocks } from '../../../src/features/notification/infrastructure/ui/welcome-blocks';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * MARCEL NE S'ANNONCE PAS COMME UNE MACHINE — ET C'EST LE CODE QUI LE GARANTIT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le bloc STYLE demande au modèle de ne pas se dire outil, agent ou IA. Une consigne est
 * PROBABLE — ce dépôt l'a mesurée en échec quatre fois : la couverture des extraits, la
 * rédaction du contenu de document, le `recipient` d'un document, et les codes internes
 * récités par Gemini. À chaque fois, la consigne était juste, lisible, et ignorée.
 *
 * Ce test porte donc sur ce qu'on peut GARANTIR : les textes que le dépôt écrit lui-même.
 * Sur ceux-là, aucune probabilité n'entre en jeu.
 *
 * ⚠️ CE TEST NE PRÉTEND PAS QUE MARCEL EST HUMAIN, et c'est une distinction qui compte.
 * L'interdiction porte sur l'AUTO-DÉSIGNATION comme outil — une phrase qui parle de la
 * machine au lieu de parler à la personne. Elle n'oblige nulle part à revendiquer une
 * humanité, et le message de détresse continue de dire « je ne suis pas la bonne personne
 * pour ça » : à cet endroit précis, entretenir l'illusion nuirait à quelqu'un de vulnérable.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../../src');

/**
 * ⚠️ Le seul fichier exempté, et pour une raison mécanique : c'est celui qui DÉCLARE les
 * motifs interdits. S'il n'était pas exclu, ce test échouerait sur sa propre définition.
 */
const SELF_DECLARING = path.join(SRC, 'shared', 'assistant-identity.ts');

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, acc);
    else if (full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/**
 * Les COMMENTAIRES sont retirés avant l'analyse.
 *
 * Ce dépôt commente abondamment, et ses commentaires citent constamment les textes qu'ils
 * expliquent — y compris ceux qu'on vient de supprimer, pour en garder la trace. Les compter
 * ferait échouer le test sur la mémoire de la correction plutôt que sur un défaut réel.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Aucun texte du dépôt ne présente Marcel comme une machine', () => {
  it('ne contient aucune auto-désignation en outil, agent, bot ou IA', () => {
    const coupables: string[] = [];

    for (const file of collectTsFiles(SRC)) {
      if (file === SELF_DECLARING) continue;
      const code = stripComments(fs.readFileSync(file, 'utf-8'));

      for (const pattern of MACHINE_SELF_DESIGNATIONS) {
        const found = code.match(new RegExp(pattern.source, 'gi'));
        if (found) {
          coupables.push(`${path.relative(SRC, file)} → ${[...new Set(found)].join(', ')}`);
        }
      }
    }

    expect(coupables, 'auto-désignations trouvées dans du code (hors commentaires)').toEqual([]);
  });

  it('reconnaît bien les formulations qu’il interdit — sinon il ne prouverait rien', () => {
    // ⚠️ Sans cette assertion, un motif cassé rendrait le test précédent vert et VIDE de
    // sens. C'est le défaut qu'ont eu `READ_ONLY_TOOL_NAMES` (désarmé, gardant un outil
    // retiré) et le test annoncé dans son en-tête, qui n'existait pas.
    expect(namesItselfAsMachine("Je suis un outil d'onboarding")).toBe(true);
    expect(namesItselfAsMachine("En tant qu'agent, je ne peux pas")).toBe(true);
    expect(namesItselfAsMachine('Je suis une IA conversationnelle')).toBe(true);
    expect(namesItselfAsMachine("I'm an AI assistant")).toBe(true);
    expect(namesItselfAsMachine('assistant virtuel de Kisso')).toBe(true);

    // Et ce qu'il ne doit PAS attraper : parler d'un humain, ou de son propre travail.
    expect(namesItselfAsMachine("Je suis là si tu as besoin d'autre chose")).toBe(false);
    expect(namesItselfAsMachine('Je ne suis pas la bonne personne pour ça')).toBe(false);
    expect(namesItselfAsMachine('Je suis en train de préparer ton document')).toBe(false);
  });
});

describe('Marcel se présente, et au bon endroit', () => {
  it('donne son nom dans CHAQUE variante de salutation', () => {
    // Une variante anonyme sur trois suffirait à casser l'illusion, et le tirage étant
    // déterministe, la personne qui tombe dessus y tombera toujours.
    for (const variante of GREETING_REPLIES) {
      expect(variante, variante).toContain(ASSISTANT_NAME);
    }
  });

  it('se présente dans le tout premier message envoyé à un arrivant', () => {
    // `buildWelcomeBlocks` est le DM de `handleTeamJoin` : le premier mot de l'entreprise à
    // quelqu'un qui vient d'arriver. C'est l'endroit où ne pas avoir de nom coûte le plus.
    const texte = JSON.stringify(buildWelcomeBlocks({ slackUserId: 'U0TEST', firstName: 'Awa' }));
    expect(texte).toContain(ASSISTANT_NAME);
  });

  it('tient sous la borne de longueur que le test de salutation impose déjà', () => {
    // Le prénom est payé par le raccourcissement de la question, pas par un dépassement.
    expect(GREETING_REPLY.length).toBeLessThan(200);
  });
});

describe('Le bloc STYLE porte la consigne, et reste sous son plafond', () => {
  it('nomme Marcel et interdit l’auto-désignation', () => {
    expect(AGENT_STYLE_BLOCK).toContain(ASSISTANT_NAME);
    expect(AGENT_STYLE_BLOCK).toMatch(/ne te dis jamais outil/i);
  });

  it('garde les consignes issues de régressions de production', () => {
    // ⚠️ « sans exclamation » RESTE, malgré la demande d'un ton chaleureux, et ce n'est pas
    // une contradiction : le constat de la testeuse était que « les points d'exclamation
    // arrivent précisément dans les phrases où il ne fait rien ». L'enthousiasme ponctuel
    // avait servi de CAMOUFLAGE à l'inaction. La chaleur passe par le nom et l'adresse.
    expect(AGENT_STYLE_BLOCK).toMatch(/exclamation/i);
    expect(AGENT_STYLE_BLOCK).toMatch(/tutoie/i);
  });

  it('ne nomme jamais l’identifiant interne — ce sont deux choses différentes', () => {
    // « Marcel » sort à chaque conversation ; `KISSO-AGENT-v3` est censuré en sortie et
    // détruit la réponse entière s'il apparaît. Les confondre rendrait le bot muet.
    expect(AGENT_STYLE_BLOCK).not.toContain('KISSO-AGENT-v3');
  });
});
