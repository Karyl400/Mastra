import { describe, it, expect } from 'vitest';

import {
  buildProfileInviteBlocks,
  buildWelcomeBlocks,
} from '../../../src/features/notification/infrastructure/ui/welcome-blocks';
import { writtenGuide } from '../../../src/shared/onboarding-video';
import { claimsProfileDone } from '../../../src/shared/profile-done';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * PLUS AUCUN BOUTON — décision du propriétaire, 2026-08-19
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Les sondes signées mesuraient pourtant des ACK de 393 à 1 473 ms, et 1 384 ms à froid après
 * 14 minutes d'inactivité — tous très en deçà des 3 s de Slack. Mais le propriétaire a signalé
 * DEUX FOIS que les boutons ne fonctionnent pas sous un vrai clic humain, et un désaccord entre
 * une mesure et l'expérience répétée de l'utilisateur ne se tranche pas en répétant la mesure.
 *
 * On supprime donc la DÉPENDANCE, pas le symptôme. Il reste plusieurs causes possibles hors du
 * code — la Request URL d'*Interactivity* n'a jamais été vérifiée dans la console Slack, et
 * `TODO.md` la porte comme tâche ouverte depuis des jours — et aucune n'est observable d'ici.
 * Le conversationnel, lui, ne dépend que de `message.im`, qui est prouvé fonctionnel à chaque
 * campagne.
 *
 * ⚠️ Ce n'est pas une régression de capacité : « j'ai fini » à l'écrit fait EXACTEMENT ce que
 * faisait le bouton — `verifyProfile` est partagé, pas réécrit.
 */

const prefill = {
  slackUserId: 'U0TEST',
  email: 'karyl@kisso.com',
  firstName: 'Karyl',
  lastName: 'SOUMAILA',
};

function actionBlocks(blocks: ReadonlyArray<{ type: string }>) {
  return blocks.filter((b) => b.type === 'actions');
}

describe('les messages d’accueil ne portent plus AUCUN bouton', () => {
  it('le DM d’arrivée est du texte, et rien d’autre', () => {
    const blocks = buildWelcomeBlocks(prefill);

    expect(actionBlocks(blocks)).toEqual([]);
    expect(JSON.stringify(blocks)).not.toContain('button');
    expect(JSON.stringify(blocks)).not.toContain('action_id');
  });

  it('le rattrapage d’une personne déjà présente non plus', () => {
    const blocks = buildProfileInviteBlocks();

    expect(actionBlocks(blocks)).toEqual([]);
    expect(JSON.stringify(blocks)).not.toContain('action_id');
  });

  it('ne transporte plus AUCUN pré-remplissage — il n’a plus de destinataire', () => {
    // Le `value` du bouton portait les données personnelles pré-remplies. Sans bouton, les
    // transporter serait une donnée qui voyage sans raison — et c'est ce `value` qui imposait
    // la restriction « DM uniquement » pour des motifs de sécurité.
    const json = JSON.stringify(buildWelcomeBlocks(prefill));
    expect(json).not.toContain('karyl@kisso.com');
  });
});

describe('le guide dit ce qu’il faut ÉCRIRE, plus sur quoi cliquer', () => {
  it('n’invite plus à cliquer', () => {
    const guide = writtenGuide();

    expect(guide).not.toMatch(/clique/i);
    expect(guide).not.toContain('C’est fait');
    expect(guide).toMatch(/j’ai fini|j'ai fini/);
  });

  it('garde les trois choses à préparer, et la numérotation continue', () => {
    const guide = writtenGuide();

    expect(guide).toContain('ton nom et ton prénom');
    expect(guide).toContain('adresse email');
    expect(guide).toContain('intitulé de ton poste');
    expect(guide).toContain('*1.*');
    expect(guide).toContain('*2.*');
  });
});

describe('« j’ai fini » et ses synonymes — c’est désormais la SEULE porte', () => {
  const acceptes = [
    "j'ai fini",
    'ça y est',
    'ok, c’est bon',
    "ok c'est fait",
    'c’est prêt',
    'terminé',
    'voilà, c’est fini',
    'dossier rempli',
  ];

  const refuses = ["je n'ai pas fini", 'pas encore fini', 'je vais le faire', 'comment je fais ?'];

  it('reconnaît les formules qu’un humain emploie réellement', () => {
    for (const t of acceptes) expect(claimsProfileDone(t), t).toBe(true);
  });

  it('ne se laisse pas prendre par une négation ni par une intention', () => {
    for (const t of refuses) expect(claimsProfileDone(t), t).toBe(false);
  });
});
