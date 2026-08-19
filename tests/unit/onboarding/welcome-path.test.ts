import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import { verifyProfile } from '../../../src/features/onboarding/domain/services/profile-completion';
import {
  PROFILE_QUESTIONS,
  answersFromRecord,
  captureProfileAnswer,
  collectProfileAnswers,
  nextProfileStep,
  pendingProfileStep,
} from '../../../src/features/onboarding/domain/services/profile-chat';
import {
  INTERVIEW_QUESTION_DAILY,
  INTERVIEW_QUESTION_STYLE,
  captureInterviewAnswer,
  pendingInterviewStep,
  skipsInterview,
} from '../../../src/features/onboarding/domain/services/interview-chat';
import {
  ONBOARDING_VIDEO_PATH,
  onboardingVideoUrl,
  videoLine,
  writtenGuide,
} from '../../../src/shared/onboarding-video';
import {
  buildProfileInviteBlocks,
  buildWelcomeBlocks,
} from '../../../src/features/notification/infrastructure/ui/welcome-blocks';

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
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
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

  it('DÉDUIT l’URL du déploiement, sans variable à poser', () => {
    // La vidéo est un actif de NOTRE déploiement (`.vercel/output/static/`) : son URL est donc
    // connue du code. La faire dépendre d'une variable posée à la main, c'est deux choses qui
    // doivent s'accorder — donc deux choses qui finissent par diverger, sur le premier message
    // que l'entreprise envoie à un arrivant.
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'kisso.vercel.app';

    expect(onboardingVideoUrl()).toBe(`https://kisso.vercel.app${ONBOARDING_VIDEO_PATH}`);
    expect(videoLine()).toContain(ONBOARDING_VIDEO_PATH);
  });

  it('la variable explicite PRIME sur la valeur déduite', () => {
    // C'est ce qui permet d'héberger la vidéo ailleurs sans toucher au code.
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'kisso.vercel.app';
    process.env.ONBOARDING_VIDEO_URL = 'https://cdn.kisso.example/tuto.mp4';

    expect(onboardingVideoUrl()).toBe('https://cdn.kisso.example/tuto.mp4');
  });

  it('le chemin de l’actif est en ASCII pur', () => {
    // Il traverse trois écritures — le disque, le CDN, un lien Slack — qui n'encodent pas
    // toutes un accent de la même façon. Le fichier d'origine s'appelait
    // « tuto_complétion_de_profil.mp4 » ; le renommer était le correctif, pas un détail.
    expect(ONBOARDING_VIDEO_PATH).toMatch(/^\/[a-z0-9/.-]+$/);
  });

  it('l’actif référencé EXISTE réellement dans le dépôt', () => {
    // Le pendant local du contrôle de build (`fix-vercel-output.js` échoue si le fichier
    // manque). Puisque l'URL est désormais DÉDUITE, plus aucune configuration ne signalerait
    // sa disparition : seul un contrôle sur le fichier lui-même le peut.
    expect(existsSync(join(process.cwd(), 'public', ONBOARDING_VIDEO_PATH))).toBe(true);
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

    // ⚠️ « email professionnelle » a été RETIRÉ le 2026-08-19. Le guide affirmait « prépare
    // trois choses, TU LES AS DÉJÀ » alors qu'il n'existe aucun provisioning de compte dans
    // ce système : une arrivante sans adresse d'entreprise se heurtait ensuite à une relance
    // sans issue. Ce qui compte n'est pas le mot, c'est que le guide et la question
    // conversationnelle disent la MÊME chose — donc qu'une adresse personnelle convient.
    expect(text).toContain('adresse email');
    expect(text).toMatch(/personnelle/i);
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
    expect(verdict.needsProfileChat).toBe(true);
  });

  it('POSE la question du champ manquant, et pas seulement son nom', () => {
    // ⚠️ L'invariant qui fait tenir la seconde machine à états : nommer ce qui manque sans
    // rien demander laisserait le fil sans question en attente, et la réponse de la personne
    // partirait chez un agent. C'est la faute exacte mesurée sur la machine jumelle.
    const verdict = verifyProfile({ ...full, position: '' });
    expect(verdict.reply).toContain(PROFILE_QUESTIONS.position);

    // Aucun dossier : on commence par le premier champ, pas par le dernier.
    expect(verifyProfile(null).reply).toContain(PROFILE_QUESTIONS.firstName);
  });

  it('ne propose PLUS de formulaire à ouvrir — la modale a disparu', () => {
    // Elle ne s'ouvrait jamais : `trigger_id` valable 3 s, démarrage à froid mesuré à 5,2 s.
    // Un test le verrouille pour qu'une reformulation ne la réintroduise pas par le texte.
    for (const verdict of [verifyProfile(null), verifyProfile({ ...full, position: '' })]) {
      expect(verdict.reply).not.toMatch(/formulaire|ci-dessous|ouvre/i);
    }
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

  it('ne demande rien de plus quand tout est là', () => {
    const verdict = verifyProfile(full);

    expect(verdict.complete).toBe(true);
    expect(verdict.needsProfileChat).toBe(false);
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

  it('reconnaît la question DANS le verdict de « C’est fait »', () => {
    // ⚠️ LE TEST QUI MANQUAIT, et son absence a laissé passer un défaut jusqu'en production
    // le 2026-08-19. Les tests d'origine passaient la CONSTANTE au détecteur ; le message
    // réellement posté, lui, est « Ton dossier est complet… On enchaîne. Dis-moi… ». Avec un
    // `startsWith`, la reconnaissance échouait sur le chemin NOMINAL — la question
    // s'affichait parfaitement et la réponse partait chez l'agent, sans aucun signal.
    //
    // La leçon est celle que ce dépôt répète : éprouver le texte que le système PRODUIT, pas
    // celui qu'on croit qu'il produit.
    const verdict = verifyProfile({
      firstName: 'Karyl',
      lastName: 'SOUMAILA',
      email: 'k@kisso.com',
      position: 'Dev',
    }).reply;

    expect(verdict.startsWith(INTERVIEW_QUESTION_DAILY)).toBe(false);
    expect(pendingInterviewStep(verdict)).toBe('dailyWork');
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

  it('REFUSE une phrase qui parle d’autre chose que de la question', () => {
    // ⚠️ Relevé en production le 2026-08-19 : « je n'ai pas fini », écrit juste après « ce
    // que tu fais au quotidien ? », a été enregistré comme la description du métier de
    // quelqu'un. Ce champ est imprimé dans le guide d'accueil, sous « Ton quotidien », dans
    // un document qui porte le nom de la personne. Même famille que le refus de « ok ».
    for (const noise of ["je n'ai pas fini", "c'est fait", "j'ai terminé", 'je n’ai pas fini']) {
      expect(captureInterviewAnswer(noise), noise).toBeNull();
    }
  });

  it('n’écarte PAS une vraie réponse qui contient un de ces mots', () => {
    // La garde porte sur l'OUVERTURE de la phrase, pas sur la présence d'un mot : « je fais
    // du support et je termine les tickets » est une réponse parfaitement valide.
    expect(captureInterviewAnswer('je fais du support et je termine les tickets')).not.toBeNull();
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

describe('les DEUX chemins vers le formulaire suivent le MÊME parcours', () => {
  /**
   * ⚠️ Défaut corrigé le 2026-08-19, et il avait survécu à la refonte du matin même.
   *
   * Il existe deux entrées vers la complétion du profil : le DM d'accueil d'un ARRIVANT
   * (`buildWelcomeBlocks`, déclenché par l'arrivée dans le workspace) et la demande d'une
   * personne DÉJÀ PRÉSENTE qui écrit « comment je complète mon profil ? »
   * (`buildProfileInviteBlocks`). Le relevé du 2026-08-14 explique pourquoi le second
   * existe : 2 fiches employés pour 6 personnes réelles, les quatre autres étant arrivées
   * AVANT l'installation du bot — c'est un chemin de RATTRAPAGE, donc le plus utilisé.
   *
   * Seul le premier avait été refait. Le second restait sur l'ancien bouton : pas de vidéo,
   * pas de guide, et surtout aucune vérification — cassé par la même cause que celui qu'on
   * venait de réparer. C'est la divergence classique de ce dépôt : deux émetteurs pour un
   * même geste, et celui qu'on exerce le moins est celui qui pourrit.
   */
  const paths = [
    ['arrivant', buildWelcomeBlocks(prefill)],
    ['déjà présent', buildProfileInviteBlocks(prefill)],
  ] as const;

  it.each(paths)('« %s » propose « C’est fait », jamais l’ancien bouton', (_name, blocks) => {
    const json = JSON.stringify(blocks);

    expect(json).toContain('profile_done');
    expect(json).not.toContain('complete_profile');
    expect(json).toContain('C’est fait');
  });

  it.each(paths)('« %s » DIT ce qui sera demandé', (_name, blocks) => {
    const json = JSON.stringify(blocks);

    expect(json).toContain('adresse email');
    expect(json).toMatch(/personnelle/i);
    expect(json).toContain('poste');
  });

  it.each(paths)('« %s » cite la vidéo dès qu’elle existe', (_name) => {
    process.env.ONBOARDING_VIDEO_URL = 'https://kisso.example/tuto';
    const blocks =
      _name === 'arrivant' ? buildWelcomeBlocks(prefill) : buildProfileInviteBlocks(prefill);

    expect(JSON.stringify(blocks)).toContain('https://kisso.example/tuto');
  });

  it('garde des phrases d’OUVERTURE distinctes', () => {
    // « Ravi de t'accueillir chez Kisso » adressé à quelqu'un qui est là depuis six mois
    // sonne faux — c'est toute la raison d'être du second chemin. Seule l'ouverture diffère ;
    // tout le reste est partagé, sans quoi les deux finiraient par ne plus dire la même chose.
    const arrivant = JSON.stringify(buildWelcomeBlocks(prefill));
    const present = JSON.stringify(buildProfileInviteBlocks(prefill));

    expect(arrivant).toContain('accueillir');
    expect(present).not.toContain('accueillir');
  });
});

describe('« Parlons de toi » est NOMMÉ au moment où il commence', () => {
  it('annonce l’étape, et pose quand même la question', () => {
    // L'étape a un nom dans le produit depuis l'origine ; la refonte l'avait fait disparaître
    // en remplaçant le bouton par une simple question. Un parcours dont les étapes n'ont pas
    // de nom est un parcours dont on ne sait pas où on en est.
    const reply = verifyProfile({
      firstName: 'Karyl',
      lastName: 'SOUMAILA',
      email: 'k@kisso.com',
      position: 'Dev',
    }).reply;

    expect(reply).toContain('Parlons de toi');
    // ⚠️ Et l'invariant tient toujours : la machine à états doit encore reconnaître l'étape.
    expect(pendingInterviewStep(reply)).toBe('dailyWork');
  });
});
