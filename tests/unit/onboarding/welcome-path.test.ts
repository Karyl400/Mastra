import { describe, it, expect, afterEach } from 'vitest';

import { verifyProfile } from '../../../src/features/onboarding/domain/services/profile-completion';
import {
  INTERVIEW_QUESTION_DAILY,
  INTERVIEW_QUESTION_STYLE,
  captureInterviewAnswer,
  pendingInterviewStep,
  skipsInterview,
} from '../../../src/features/onboarding/domain/services/interview-chat';
import { onboardingVideoUrl, videoLine, writtenGuide } from '../../../src/shared/onboarding-video';
import { buildWelcomeBlocks } from '../../../src/features/notification/infrastructure/ui/welcome-blocks';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE PARCOURS D'ACCUEIL, REFAIT SANS MODALE — 2026-08-19
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Cause du refonte, mesurée et non supposée : un `trigger_id` Slack expire 3 secondes après
 * le clic, et le démarrage à froid de la fonction Vercel a été mesuré à 4,9 s le 2026-08-18,
 * jusqu'à 16 s après une longue inactivité. Les deux boutons qui ouvraient une modale —
 * « Compléter mon profil » et « Parlons de toi » — ne pouvaient donc pas fonctionner dans le
 * cas NORMAL de ce produit, qui voit ≈ 19 messages par jour et dont l'utilisateur type est un
 * ARRIVANT, c'est-à-dire le premier à écrire de la journée.
 */

const prefill = {
  slackUserId: 'U0TEST',
  email: 'karyl@kisso.com',
  firstName: 'Karyl',
  lastName: 'SOUMAILA',
};

afterEach(() => {
  delete process.env.ONBOARDING_VIDEO_URL;
});

describe('la vidéo ne devient jamais une promesse creuse', () => {
  it('la phrase DISPARAÎT quand l’URL n’est pas posée', () => {
    // Règle la plus constante du dépôt : on ne promet jamais ce qu'aucun mécanisme ne tient.
    // `ONBOARDING_WELCOME_CHANNELS` fait déjà disparaître « Je t'ai ajouté à … », et l'email
    // de bienvenue a perdu « vous recevrez prochainement les accès ». Un lien mort dans le
    // PREMIER message de l'entreprise à quelqu'un dit « personne n'a vérifié ».
    expect(videoLine()).toBe('');
    expect(onboardingVideoUrl()).toBeUndefined();
  });

  it('cite l’URL quand elle est posée', () => {
    process.env.ONBOARDING_VIDEO_URL = 'https://kisso.example/accueil';
    expect(videoLine()).toContain('https://kisso.example/accueil');
  });

  it('REFUSE ce qui n’est pas une URL web', () => {
    // La valeur finit dans un lien cliquable Slack. `javascript:` y serait un vecteur, et une
    // valeur mal collée (un chemin, un identifiant nu) produirait un lien mort : les deux se
    // traitent au même endroit.
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'pas-une-url', '/videos/1']) {
      process.env.ONBOARDING_VIDEO_URL = bad;
      expect(onboardingVideoUrl(), bad).toBeUndefined();
      expect(videoLine(), bad).toBe('');
    }
  });

  it('la numérotation du guide reste continue dans les deux cas', () => {
    // Un trou dans la liste (« 2. » sans « 1. ») signale à l'arrivant qu'on lui cache une
    // étape — défaut de confiance sur le premier message reçu.
    expect(writtenGuide()).toContain('*1.*');
    process.env.ONBOARDING_VIDEO_URL = 'https://kisso.example/accueil';
    expect(videoLine()).toContain('*1.*');
    expect(writtenGuide()).toContain('*2.*');
  });
});

describe('le message d’accueil', () => {
  it('n’expose plus « Compléter mon profil » en porte d’entrée', () => {
    const blocks = buildWelcomeBlocks(prefill);
    const ids = blocks.flatMap((block) => {
      const elements = (block as { elements?: Array<{ action_id?: string }> }).elements ?? [];
      return elements.map((element) => element.action_id ?? '');
    });

    expect(ids).toContain('profile_done');
    expect(ids).not.toContain('complete_profile');
  });

  it('DIT ce qui va être demandé', () => {
    // L'ancien message annonçait « il me manque une information » sans dire laquelle : la
    // personne ouvrait la modale, y découvrait qu'il lui fallait son adresse pro, et la
    // refermait pour aller la chercher.
    const text = JSON.stringify(buildWelcomeBlocks(prefill));

    expect(text).toContain('email professionnelle');
    expect(text).toContain('poste');
  });

  it('est du mrkdwn Slack, jamais du markdown GitHub', () => {
    expect(JSON.stringify(buildWelcomeBlocks(prefill))).not.toContain('**');
  });
});

describe('« C’est fait » VÉRIFIE, il ne se contente pas de remercier', () => {
  const full = { firstName: 'Karyl', lastName: 'SOUMAILA', email: 'k@kisso.com', position: 'Dev' };

  it('distingue « aucun dossier » de « dossier incomplet »', () => {
    // Même règle que `found: false` porteur d'un `reason` : un résultat vide doit se
    // distinguer d'un identifiant qui ne désigne personne. « Il me manque ton poste » adressé
    // à quelqu'un qui n'a aucun dossier serait faux et déroutant.
    const none = verifyProfile(null);
    const partial = verifyProfile({ ...full, position: '' });

    expect(none.reply).not.toBe(partial.reply);
    expect(none.reply).toMatch(/pas encore de dossier/i);
    expect(partial.reply).toMatch(/il me manque/i);
  });

  it('NOMME le champ manquant', () => {
    const verdict = verifyProfile({ ...full, position: '   ' });

    expect(verdict.complete).toBe(false);
    expect(verdict.reply).toContain('poste');
    expect(verdict.offerForm).toBe(true);
  });

  it('énumère lisiblement quand il en manque plusieurs', () => {
    const verdict = verifyProfile({
      firstName: '',
      lastName: '',
      email: 'k@kisso.com',
      position: '',
    });

    expect(verdict.missing).toHaveLength(3);
    expect(verdict.reply).toContain(' et ');
  });

  it('ne propose PAS le formulaire quand tout est là', () => {
    const verdict = verifyProfile(full);

    expect(verdict.complete).toBe(true);
    expect(verdict.offerForm).toBe(false);
  });

  it('enchaîne sur la PREMIÈRE question de l’entretien, mot pour mot', () => {
    // ⚠️ L'invariant qui fait tenir la machine à états : l'étape en cours est reconnue en
    // comparant le dernier tour du bot à cette constante. Une reformulation locale, même
    // strictement synonyme, casserait la reconnaissance en silence.
    expect(verifyProfile(full).reply).toContain(INTERVIEW_QUESTION_DAILY);
  });
});

describe('l’entretien conversationnel — l’état est le dernier tour du bot', () => {
  it('reconnaît chaque question', () => {
    expect(pendingInterviewStep(INTERVIEW_QUESTION_DAILY)).toBe('dailyWork');
    expect(pendingInterviewStep(INTERVIEW_QUESTION_STYLE)).toBe('workStyle');
  });

  it('reconnaît la question MÊME suivie d’une note accolée par le handler', () => {
    // Le handler accole parfois une note (requalification d'un accompli, promesse d'envoi
    // démentie, couverture d'extraits). Une égalité stricte échouerait alors en silence —
    // exactement la classe de défaut que ce dépôt traque.
    const withNote = `${INTERVIEW_QUESTION_DAILY}\n\n_Note : …_`;
    expect(pendingInterviewStep(withNote)).toBe('dailyWork');
  });

  it('ne se déclenche sur AUCUN autre message', () => {
    for (const other of [
      'Bonjour',
      '',
      undefined,
      'Ton document est prêt.',
      'dis-moi ce que tu fais',
    ]) {
      expect(pendingInterviewStep(other), String(other)).toBeNull();
    }
  });

  it('REFUSE l’accusé de réception comme description d’un métier', () => {
    // Sans cela « ok » serait enregistré comme le quotidien de quelqu'un, puis imprimé dans
    // son guide d'accueil sous « Ton quotidien ».
    for (const noise of ['ok', '👍', '  ', 'oui'])
      expect(captureInterviewAnswer(noise), noise).toBeNull();
  });

  it('accepte une phrase, et la borne', () => {
    expect(captureInterviewAnswer('je code le backend')).toBe('je code le backend');
    expect(captureInterviewAnswer('a'.repeat(500))!.length).toBe(280);
  });

  it('reconnaît le renoncement AVANT de juger la réponse trop courte', () => {
    // « non » fait moins que le seuil : le traiter comme une réponse ratée relancerait la
    // question à quelqu'un qui vient de dire non, ce qui est le meilleur moyen de faire
    // abandonner un questionnaire d'accueil pour de bon.
    for (const skip of ['passe', 'plus tard', 'non merci', 'pas maintenant']) {
      expect(skipsInterview(skip), skip).toBe(true);
    }
    expect(skipsInterview('je code le backend')).toBe(false);
  });
});
