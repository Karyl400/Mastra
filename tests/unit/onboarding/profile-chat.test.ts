import { describe, it, expect } from 'vitest';

import {
  PROFILE_QUESTIONS,
  PROFILE_STEP_ORDER,
  answersFromRecord,
  captureProfileAnswer,
  collectProfileAnswers,
  nextProfileStep,
  pendingProfileStep,
  profileRetryReply,
} from '../../../src/features/onboarding/domain/services/profile-chat';
import {
  INTERVIEW_QUESTION_DAILY,
  INTERVIEW_QUESTION_STYLE,
  pendingInterviewStep,
} from '../../../src/features/onboarding/domain/services/interview-chat';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * COMPLÉTER SON DOSSIER EN CONVERSATION — la dernière modale disparaît
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Cause, mesurée le 2026-08-19 sur un clic SIGNÉ en production : l'ACK de
 * `/slack/interactions` mettait 5 229 ms à froid et 9 173 ms sur un déploiement neuf, alors
 * qu'un `trigger_id` Slack expire en 3 secondes. Le portier d'ACK a ramené l'accusé sous la
 * seconde, mais il ne peut pas sauver une modale : il répond vite parce qu'il ne connaît rien
 * du produit, et la fenêtre s'ouvre ensuite, depuis la fonction restée froide.
 */

describe('l’état est le dernier tour du bot, comme pour l’entretien', () => {
  it('reconnaît chaque question', () => {
    for (const step of PROFILE_STEP_ORDER) {
      expect(pendingProfileStep(PROFILE_QUESTIONS[step]), step).toBe(step);
    }
  });

  it('reconnaît une question ENCADRÉE de texte', () => {
    // ⚠️ Le cas NOMINAL : le verdict de « C'est fait » dit d'abord ce qui manque, puis pose la
    // question. Et le handler accole parfois des notes en fin de réponse. `startsWith`
    // échouerait donc systématiquement — la faute exacte mesurée sur la machine jumelle le
    // 2026-08-19, sur le chemin nominal, sans le moindre signal.
    const framed = `Il me manque ton poste.\n\n${PROFILE_QUESTIONS.position}\n\n_(note)_`;
    expect(pendingProfileStep(framed)).toBe('position');
  });

  it('ne confond JAMAIS avec les questions de l’entretien', () => {
    // Les deux machines lisent le même endroit. Si un prédicat reconnaissait le texte de
    // l'autre, le parcours boucherait sans qu'aucun type ne bouge.
    for (const step of PROFILE_STEP_ORDER) {
      expect(pendingInterviewStep(PROFILE_QUESTIONS[step]), step).toBeNull();
    }
    expect(pendingProfileStep(INTERVIEW_QUESTION_DAILY)).toBeNull();
    expect(pendingProfileStep(INTERVIEW_QUESTION_STYLE)).toBeNull();
  });

  it('rend null sur un texte quelconque', () => {
    expect(pendingProfileStep('bonjour')).toBeNull();
    expect(pendingProfileStep(undefined)).toBeNull();
    expect(pendingProfileStep('')).toBeNull();
  });
});

describe('ce qu’on accepte comme réponse', () => {
  it('retient un prénom, un nom, un poste', () => {
    expect(captureProfileAnswer('firstName', ' Karyl ')).toBe('Karyl');
    expect(captureProfileAnswer('lastName', 'SOUMAILA')).toBe('SOUMAILA');
    expect(captureProfileAnswer('position', 'Backend Developer')).toBe('Backend Developer');
  });

  it('accepte un nom qui ne s’écrit pas en alphabet latin', () => {
    // Le filtre porte sur `\p{L}`, jamais sur `[a-z]` : un filtre latin refuserait le nom de
    // la moitié du monde, et le message serait « je n'ai pas su en tirer une réponse ».
    expect(captureProfileAnswer('firstName', 'Мария')).toBe('Мария');
    expect(captureProfileAnswer('lastName', '田中')).toBe('田中');
  });

  it('normalise et minuscule une adresse', () => {
    expect(captureProfileAnswer('email', '  Karyl.S@Kisso.COM ')).toBe('karyl.s@kisso.com');
  });

  it('REFUSE ce qui n’est pas une adresse', () => {
    for (const bad of ['karyl', 'karyl@kisso', 'karyl at kisso.com', 'a@b.c', 'a@@b.com']) {
      expect(captureProfileAnswer('email', bad), bad).toBeNull();
    }
  });

  it('REFUSE un refus, au lieu de l’enregistrer comme une valeur', () => {
    // ⚠️ Sans cette garde, « je n'ai pas d'adresse pro » deviendrait l'adresse de la personne
    // — le champ qui sert à retrouver son dossier. Même famille que le « je n'ai pas fini »
    // enregistré comme métier le 2026-08-18, constaté en base.
    for (const refusal of ['je ne sais pas', 'aucun', 'rien', 'c’est quoi ?']) {
      expect(captureProfileAnswer('position', refusal), refusal).toBeNull();
    }
  });

  it('laisse passer une vraie réponse qui contient des mots ordinaires', () => {
    // Contre-test du précédent : la garde est ancrée au DÉBUT du message.
    expect(captureProfileAnswer('position', 'Support technique, je sais tout faire')).toBe(
      'Support technique, je sais tout faire',
    );
  });

  it('REFUSE un pavé', () => {
    expect(captureProfileAnswer('firstName', 'x'.repeat(200))).toBeNull();
  });

  it('la relance NOMME ce qui cloche', () => {
    // « Je n'ai pas compris » renvoie à la même question sans dire quoi changer, et coûte un
    // aller-retour de plus sur un budget qui se compte à la journée.
    expect(profileRetryReply('email')).toContain('@');
    expect(profileRetryReply('email')).toContain(PROFILE_QUESTIONS.email);
    expect(profileRetryReply('position')).toContain(PROFILE_QUESTIONS.position);
  });
});

describe('l’état se reconstitue du fil, jamais d’une table', () => {
  const turn = (role: string, content: string) => ({ role, content });

  it('apparie les questions posées et les réponses données', () => {
    const answers = collectProfileAnswers([
      turn('assistant', `On y va.\n\n${PROFILE_QUESTIONS.firstName}`),
      turn('user', 'Karyl'),
      turn('assistant', PROFILE_QUESTIONS.lastName),
      turn('user', 'SOUMAILA'),
    ]);

    expect(answers).toEqual({ firstName: 'Karyl', lastName: 'SOUMAILA' });
  });

  it('la DERNIÈRE réponse l’emporte — on peut se corriger', () => {
    const answers = collectProfileAnswers([
      turn('assistant', PROFILE_QUESTIONS.email),
      turn('user', 'karyl@kisso.com'),
      turn('assistant', PROFILE_QUESTIONS.email),
      turn('user', 'karyl.soumaila@kisso.com'),
    ]);

    expect(answers.email).toBe('karyl.soumaila@kisso.com');
  });

  it('ignore un tour utilisateur qui ne répond à aucune question', () => {
    const answers = collectProfileAnswers([
      turn('user', 'bonjour'),
      turn('assistant', 'Je regarde ça.'),
      turn('user', 'toujours là ?'),
    ]);

    expect(answers).toEqual({});
  });

  it('le dossier existant sert de socle : on ne redemande pas ce qu’on sait', () => {
    const known = answersFromRecord({
      firstName: 'Karyl',
      lastName: 'SOUMAILA',
      email: 'karyl@kisso.com',
      position: '   ',
    });

    expect(nextProfileStep(known)).toBe('position');
    expect(nextProfileStep({ ...known, position: 'Developer' })).toBeNull();
  });

  it('sans dossier, on commence par le premier champ', () => {
    expect(nextProfileStep(answersFromRecord(null))).toBe('firstName');
  });
});

describe('les textes postés en dur sont du mrkdwn Slack', () => {
  // ⚠️ Ils ne passent par AUCUN filtre : `sanitizeAgentOutput`, qui convertit le markdown, n'a
  // qu'un seul site d'appel — la réponse d'un MODÈLE. Un `**gras**` s'afficherait littéralement,
  // ce qui a été constaté le 2026-08-18 sur le message de détresse.
  it.each(Object.entries(PROFILE_QUESTIONS))('« %s » n’emploie pas de gras GitHub', (_k, text) => {
    expect(text).not.toContain('**');
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * L'IMPASSE DE L'EMAIL — le seul blocage dur du parcours (2026-08-19)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Relevé en lisant le parcours avec les yeux d'une arrivante : la question demandait « ton
 * adresse email *professionnelle* », le guide affirmait « prépare trois choses, TU LES AS
 * DÉJÀ » — et il n'existe AUCUN provisioning de compte dans ce système. Une personne qui
 * répondait honnêtement « je n'en ai pas encore » recevait la même relance, indéfiniment :
 * `captureProfileAnswer` rejette, `profileRetryReply` repose la question, et le mot « passe »
 * qui existe pour l'entretien n'existe pas ici.
 *
 * Il n'y avait aucune sortie. La personne abandonnait, en concluant que c'était sa faute.
 *
 * Décision du propriétaire : une adresse personnelle convient. Le correctif est donc de le
 * DIRE — la validation, elle, acceptait déjà n'importe quelle adresse bien formée.
 */
describe('l’adresse email — une adresse personnelle est explicitement acceptée', () => {
  it('accepte une adresse personnelle comme une adresse d’entreprise', () => {
    expect(captureProfileAnswer('email', 'karylsoumaila1@gmail.com')).toBe(
      'karylsoumaila1@gmail.com',
    );
    expect(captureProfileAnswer('email', 'karyl@kisso.com')).toBe('karyl@kisso.com');
    // ⚠️ On ne pose PAS de liste blanche de domaines. L'entreprise en a plusieurs
    // (`kissohq.com`, `design.kisso.xyz`, `trellix.io` relevés en production) et plusieurs
    // personnes utilisent une adresse personnelle : restreindre créerait une SECONDE impasse à
    // la place de celle qu'on ferme. Aucune autorisation ne dépend plus du domaine depuis le
    // 2026-08-20 — elle dépend du RÔLE.
    expect(captureProfileAnswer('email', 'pamela@kissohq.com')).toBe('pamela@kissohq.com');
    expect(captureProfileAnswer('email', 'nazer@design.kisso.xyz')).toBe('nazer@design.kisso.xyz');
  });

  it('la QUESTION dit qu’une adresse personnelle convient', () => {
    // C'est tout le correctif : la personne ne pouvait pas deviner qu'un gmail passait.
    expect(PROFILE_QUESTIONS.email).toMatch(/personnelle/i);
  });

  it('la RELANCE le redit — c’est elle qu’on lit quand on est bloqué', () => {
    const retry = profileRetryReply('email');
    expect(retry).toMatch(/personnelle/i);
    expect(retry).toContain('@');
  });
});
