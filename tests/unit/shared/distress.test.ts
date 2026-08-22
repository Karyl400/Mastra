import { describe, expect, it } from 'vitest';
import {
  DISTRESS_REPLY,
  DISTRESS_REPLY_EN,
  detectsDistress,
  distressLanguage,
  distressReplyFor,
  AGGRESSION_REPLY,
  AGGRESSION_REPLY_EN,
  distressKind,
} from '../../../src/shared/distress';
import { EMERGENCY_LINES } from '../../../src/shared/emergency-lines';
import { ESCALATION_CONTACT, ESCALATION_CONTACT_EN } from '../../../src/shared/escalation';

/**
 * ⚠️ C'est le seul module de ce dépôt où un défaut peut nuire à une PERSONNE, et non au
 * produit. L'arbitrage des tests s'en déduit : un faux négatif est bien plus grave qu'un
 * faux positif, et les deux sont testés séparément pour que personne ne « corrige » l'un en
 * cassant l'autre.
 */
describe('detectsDistress', () => {
  const INTERCEPTED = [
    'je veux mourir',
    "j'ai envie de mourir",
    'je pense à me faire du mal',
    "j'ai des idées noires depuis des semaines",
    'je ne vais pas bien du tout',
    'je suis à bout, je craque',
    'je crois que je fais un burn out',
    'je suis harcelé par mon manager',
    'je subis du harcèlement moral depuis mon arrivée',
    'mon responsable me menace tous les jours',
    "je pense que c'est de la discrimination",
  ];

  for (const text of INTERCEPTED) {
    it(`intercepte : « ${text} »`, () => {
      expect(detectsDistress(text)).toBe(true);
    });
  }

  it('reconnaît une détresse NOYÉE dans une phrase — critère inverse de la salutation', () => {
    // `isBareGreeting` exige une égalité stricte parce qu'une vraie demande commence
    // souvent par « bonjour ». Ici c'est l'inverse : une détresse est presque toujours
    // enfouie, et la manquer coûte infiniment plus cher qu'un faux positif.
    expect(
      detectsDistress(
        'Bonjour, désolé de te déranger avec ça mais je ne vais pas bien et je ne sais pas à qui en parler',
      ),
    ).toBe(true);
  });

  it("fonctionne sans accent ni majuscule — c'est ainsi qu'on écrit quand on va mal", () => {
    expect(detectsDistress('je suis harcele au travail')).toBe(true);
    expect(detectsDistress('JE VEUX MOURIR')).toBe(true);
  });

  const IGNORED = [
    'bonjour',
    "il me faudrait le guide d'accueil en PDF",
    'crée un profil pour Léa Bamba',
    'où en est mon dossier ?',
    'envoie-lui un rappel pour lundi',
    'ça ne marche pas très bien ton truc',
    "j'ai mal compris ta réponse, tu peux reformuler ?",
  ];

  for (const text of IGNORED) {
    it(`laisse passer : « ${text} »`, () => {
      expect(detectsDistress(text)).toBe(false);
    });
  }

  it("ignore un document collé — au-delà de 2000 caractères ce n'est plus une confidence", () => {
    expect(detectsDistress('a'.repeat(2001) + ' je veux mourir')).toBe(false);
  });

  it('ignore le vide', () => {
    expect(detectsDistress('')).toBe(false);
    expect(detectsDistress(undefined)).toBe(false);
    expect(detectsDistress(null)).toBe(false);
  });
});

describe('DISTRESS_REPLY', () => {
  it("NOMME un humain à joindre — c'est tout l'objet du message", () => {
    // `NEUTRAL_REFUSAL` a été réécrit pour ne renvoyer vers personne, à raison pour un refus
    // de sécurité. Cette décision avait supprimé le dernier endroit du système qui
    // mentionnait un être humain. Ici, ne renvoyer vers personne serait une faute.
    //
    // ⚠️ CE TEST DISAIT `toContain('RH')` jusqu'au 2026-08-21. Il verrouillait un renvoi vers
    // « l'équipe RH de Kisso » — instance qui N'EXISTE PAS : le workspace compte sept
    // personnes et une seule porte `role = 'manager'`. Le test était vert et la phrase
    // envoyait dans le vide, exactement comme le 3114 français avant lui.
    expect(DISTRESS_REPLY).toContain(ESCALATION_CONTACT);
  });

  it('cite les lignes VÉRIFIÉES du pays configuré — aucun numéro écrit à la main', () => {
    // ⚠️ ASSERTION DÉRIVÉE de `emergency-lines.ts`, jamais un littéral. Ce test a d'abord
    // verrouillé le 3114 (français), puis SURPIN (nigérian) ; les deux étaient des chiffres
    // recopiés qu'aucun mécanisme ne reliait au pays réel des salariés. Un numéro écrit en
    // dur dans un test est un numéro que personne ne revérifiera.
    expect(DISTRESS_REPLY).toContain(EMERGENCY_LINES.crisis.number);
    expect(DISTRESS_REPLY).toContain(EMERGENCY_LINES.medical.number);
  });

  it("n'a AUCUNE trace des numéros d'autres pays écartés à la vérification", () => {
    // Les quatre sont réels, gratuits, et joignent quelqu'un — ailleurs. C'est ce qui les
    // rend dangereux : la mauvaise réponse a toutes les apparences de la bonne.
    //   3114 → France · 122 → RD Congo · 143 → Côte d'Ivoire · 988 → États-Unis
    for (const etranger of ['3114', '988', '116 123']) {
      expect(DISTRESS_REPLY, etranger).not.toContain(etranger);
    }
  });

  it('ne diagnostique rien et ne promet aucune transmission', () => {
    expect(DISTRESS_REPLY).toContain("Je n'ai transmis ce message à personne");
  });

  it("ne s'annonce plus comme un OUTIL — mais ne prétend pas non plus être thérapeute", () => {
    // ⚠️ Le seul changement de TON consenti ici. Le texte ouvrait par « Je suis un outil
    // d'onboarding » : une phrase sur soi, au moment où quelqu'un vient de parler de lui.
    //
    // Ce qui NE change pas, et qui est l'essentiel : Marcel dit toujours qu'il n'est pas la
    // bonne personne. Simuler l'empathie auprès de quelqu'un de vulnérable serait lui mentir
    // au pire moment — c'est le seul endroit du produit où « presque humain » nuit.
    expect(DISTRESS_REPLY).not.toMatch(/je suis un outil/i);
    expect(DISTRESS_REPLY).toMatch(/pas la bonne personne/i);
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * COUVERTURE ANGLAISE — ajoutée le 2026-08-20
 * ════════════════════════════════════════════════════════════════════════════
 *
 * L'anglais est la langue officielle du Nigeria, où sont les salariés. « I want to die »
 * ne déclenchait RIEN : le message partait chez l'orchestrateur, qui répondait sur
 * l'onboarding ou refusait au titre du hors-métier. Les numéros n'étaient jamais donnés.
 *
 * Le raisonnement complet — pourquoi chaque tournure entre, et pourquoi certaines ont été
 * écartées — vit dans `docs/conception/shared.md`.
 */
describe('detectsDistress — anglais', () => {
  const INTERCEPTED_EN = [
    'I want to die',
    'I wanna die',
    "I can't go on",
    "I can't go on like this anymore",
    'I want to end it',
    'I think about killing myself',
    'I want to kill myself',
    'I want to end my life',
    "I don't want to be here anymore",
    "what's the point anymore",
    "I can't take it anymore",
    "I can't do this anymore",
    'I feel hopeless and I have nobody to talk to',
    'I am worthless',
    'I have been hurting myself',
    'I am suicidal',
    'there is no reason to live',
    'I am completely burnt out',
    'I am depressed and I cannot work',
    'my manager is harassing me',
    'I am being bullied by my team lead',
    'a colleague threatened me yesterday',
    'he assaulted me at the office party',
    'I am being discriminated against because of my accent',
  ];

  for (const text of INTERCEPTED_EN) {
    it(`intercepte : « ${text} »`, () => {
      expect(detectsDistress(text)).toBe(true);
    });
  }

  it('reconnaît une détresse NOYÉE dans une phrase anglaise', () => {
    expect(
      detectsDistress(
        "Hi, sorry to bother you with this but I can't go on and I don't know who to talk to",
      ),
    ).toBe(true);
  });

  it("fonctionne sans apostrophe — c'est ainsi qu'on écrit sur un téléphone", () => {
    // `normalizeIntentText` remplace toute ponctuation par une ESPACE : « can't » devient
    // « can t ». Une liste écrite avec des apostrophes ne matcherait donc jamais rien, et
    // une liste écrite sans apostrophe ne matcherait pas le texte apostrophé. Les deux
    // formes normalisées sont donc examinées.
    expect(detectsDistress('i cant go on')).toBe(true);
    expect(detectsDistress('I CAN’T GO ON')).toBe(true);
    expect(detectsDistress("I can't go on")).toBe(true);
  });
});

/**
 * ⚠️ LE CŒUR DU SUJET : un faux positif TROP fréquent détruit la crédibilité du dispositif.
 * L'anglais professionnel est saturé d'hyperboles mortifères — « killing me », « dying to »,
 * « dead code », « kill the process ». Aucune ne doit déclencher.
 */
describe('detectsDistress — faux positifs de l’anglais professionnel', () => {
  const IGNORED_EN = [
    'this deadline is killing me',
    "I'm dying to see the demo",
    'kill the process on port 3000',
    'we should delete that dead code',
    "I'm dead tired after the release",
    'my laptop battery is dead',
    'I killed the staging deployment by mistake',
    'can you kill my old session please',
    'the deploy died halfway through',
    'the dead letter queue is full again',
    "I'm dead serious about that estimate",
    "let's kill this feature, nobody uses it",
    'I want to end this meeting early',
    'this bug is a nightmare',
    "I'm struggling with the API docs",
    "I'm not ok with this deadline",
    'the CI is dead in the water',
    'deadline moved, I need to kill the old branch',
  ];

  for (const text of IGNORED_EN) {
    it(`laisse passer : « ${text} »`, () => {
      expect(detectsDistress(text)).toBe(false);
    });
  }
});

describe('distressLanguage — dans quelle langue répondre', () => {
  it('rend null quand rien n’est détecté', () => {
    expect(distressLanguage('où en est mon dossier ?')).toBeNull();
  });

  it('rend « fr » sur une tournure française', () => {
    expect(distressLanguage('je ne vais pas bien du tout')).toBe('fr');
  });

  it('rend « en » sur une tournure anglaise', () => {
    expect(distressLanguage("I can't go on anymore")).toBe('en');
  });

  it('rend « both » sur un mot commun aux deux langues, sans autre indice', () => {
    // « suicide », « depression », « burnout », « discrimination » s'écrivent à
    // l'identique dans les deux langues. Sur un message d'un seul mot, rien ne permet de
    // trancher — on répond donc dans les DEUX langues plutôt que de parier.
    expect(distressLanguage('suicide')).toBe('both');
    expect(distressLanguage('burnout')).toBe('both');
  });

  it('tranche un mot commun grâce aux mots-outils qui l’entourent', () => {
    expect(distressLanguage('je crois que je fais un burnout')).toBe('fr');
    expect(distressLanguage('I think I have depression')).toBe('en');
  });
});

describe('distressReplyFor', () => {
  it('rend le message FRANÇAIS, inchangé, sur une détresse française', () => {
    expect(distressReplyFor('je veux mourir')).toBe(DISTRESS_REPLY);
  });

  it('retombe sur le français quand rien n’est détecté', () => {
    // `replyFor` est appelé sur l'entrée trouvée par `findStaticReply` ; ce chemin ne peut
    // pas être atteint sans détection, mais un défaut ne doit jamais rendre `undefined`.
    expect(distressReplyFor('peu importe')).toBe(DISTRESS_REPLY);
  });

  it('rend le message ANGLAIS sur une détresse anglaise', () => {
    expect(distressReplyFor('I want to die')).toBe(DISTRESS_REPLY_EN);
  });

  it('rend les DEUX quand la langue est indécidable', () => {
    const both = distressReplyFor('suicide');
    expect(both).toContain(DISTRESS_REPLY);
    expect(both).toContain(DISTRESS_REPLY_EN);
  });
});

describe('DISTRESS_REPLY_EN', () => {
  it("cite EXACTEMENT les mêmes lignes vérifiées — aucun numéro n'est inventé", () => {
    // ⚠️ Un numéro faux consomme le seul geste que la personne aura peut-être la force de
    // faire. La version anglaise ne cite donc AUCUNE ligne que la version française ne
    // cite pas : SURPIN et le 112, vérifiés le 2026-08-18 auprès de LifeLine International.
    expect(DISTRESS_REPLY_EN).toContain(EMERGENCY_LINES.crisis.number);
    expect(DISTRESS_REPLY_EN).toContain(EMERGENCY_LINES.medical.number);
    expect(DISTRESS_REPLY_EN).not.toContain('3114');
    expect(DISTRESS_REPLY_EN).not.toContain('988');
    expect(DISTRESS_REPLY_EN).not.toContain('116 123');
  });

  it('NOMME un humain à joindre, comme la version française', () => {
    expect(DISTRESS_REPLY_EN).toContain(ESCALATION_CONTACT_EN);
  });

  it('ne promet aucune transmission', () => {
    expect(DISTRESS_REPLY_EN.toLowerCase()).toContain("haven't passed".toLowerCase());
  });

  it('est écrit en mrkdwn Slack — jamais en markdown GitHub', () => {
    // Ce texte est posté DIRECTEMENT par le handler : il ne passe pas par
    // `sanitizeAgentOutput`, qui est ce qui convertit le markdown. Constaté en production
    // le 2026-08-18 sur la version française — les `**` s'affichaient autour du numéro.
    expect(DISTRESS_REPLY_EN).not.toContain('**');
    expect(DISTRESS_REPLY_EN).toContain(`*${EMERGENCY_LINES.crisis.number}*`);
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * AGRESSION — séparée de la détresse le 2026-08-21
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Jusqu'ici, « je suis harcelé par mon manager » recevait le message de PRÉVENTION DU
 * SUICIDE. Ce n'était pas un bug de détection — la phrase était bien interceptée — mais une
 * réponse à côté : on donnait un numéro d'écoute à quelqu'un qui a besoin de la police, et on
 * ne nommait personne capable d'agir sur ce qui se passe au travail.
 */
describe('distressKind — la nature de la situation', () => {
  const AGGRESSIONS = [
    'je suis harcelé par mon manager',
    'je subis du harcèlement moral depuis mon arrivée',
    'mon responsable me menace tous les jours',
    "je pense que c'est de la discrimination",
    'je me suis fait agresser en sortant du bureau',
    'je suis en danger, il ne veut pas me laisser partir',
    'my manager is threatening me',
    'i was sexually harassed at work',
  ];

  for (const text of AGGRESSIONS) {
    it(`classe en agression : « ${text} »`, () => {
      expect(distressKind(text)).toBe('aggression');
    });
  }

  const SELF_HARM = [
    'je veux mourir',
    "j'ai des idées noires depuis des semaines",
    'je suis à bout, je craque',
    'I want to die',
    'i feel hopeless',
  ];

  for (const text of SELF_HARM) {
    it(`classe en détresse : « ${text} »`, () => {
      expect(distressKind(text)).toBe('self_harm');
    });
  }

  it('fait primer la DÉTRESSE quand un message porte les deux', () => {
    // ⚠️ Les deux erreurs ne se valent pas. Traiter une agression comme une détresse donne
    // quand même un numéro d'urgence joignable ; l'inverse répondrait par une démarche
    // administrative à quelqu'un qui pense à en finir.
    expect(distressKind("je suis harcelé et je n'en peux plus, je veux en finir")).toBe(
      'self_harm',
    );
  });

  it('ne classe rien sur un message ordinaire', () => {
    expect(distressKind("il me faudrait le guide d'accueil en PDF")).toBeNull();
    expect(distressKind('')).toBeNull();
  });
});

describe('AGGRESSION_REPLY', () => {
  it('nomme quelqu’un qui peut AGIR, pas seulement quelqu’un qui écoute', () => {
    // C'est toute la différence entre les deux textes. Une ligne d'écoute ne peut rien
    // contre un collègue qui menace ; la personne qui a autorité sur le workspace, si.
    expect(AGGRESSION_REPLY).toContain(ESCALATION_CONTACT);
    expect(AGGRESSION_REPLY).toMatch(/peut agir/i);
  });

  it('donne la police AVANT toute autre orientation', () => {
    const police = AGGRESSION_REPLY.indexOf(EMERGENCY_LINES.crisis.number);
    const manager = AGGRESSION_REPLY.indexOf(ESCALATION_CONTACT);
    expect(police).toBeGreaterThan(-1);
    // Quelqu'un en danger immédiat ne doit pas avoir à lire un paragraphe sur la hiérarchie
    // avant de trouver le numéro.
    expect(police).toBeLessThan(manager);
  });

  it('ne promet aucune transmission — même garantie que la détresse', () => {
    expect(AGGRESSION_REPLY).toContain("Je n'ai transmis ce message à personne");
    expect(AGGRESSION_REPLY_EN.toLowerCase()).toContain("haven't passed this message on");
  });

  it('est écrit en mrkdwn Slack, comme tout texte posté sans passer par le filtre', () => {
    for (const texte of [AGGRESSION_REPLY, AGGRESSION_REPLY_EN]) {
      expect(texte).not.toContain('**');
    }
    expect(AGGRESSION_REPLY).toContain(`*${EMERGENCY_LINES.crisis.number}*`);
  });

  it('est bien le texte RENDU sur une agression — la séparation va jusqu’au bout', () => {
    // ⚠️ Sans cette assertion, la classification pourrait être juste et le routage muet :
    // c'est exactement le défaut qu'a connu la base de connaissance, correcte et
    // inatteignable pendant deux jours.
    expect(distressReplyFor('je suis harcelé par mon manager')).toBe(AGGRESSION_REPLY);
    expect(distressReplyFor('i was sexually harassed at work')).toBe(AGGRESSION_REPLY_EN);
    expect(distressReplyFor('je veux mourir')).toBe(DISTRESS_REPLY);
  });
});

/**
 * ⚠️ « EN FINIR » EST AMBIGU EN FRANÇAIS DE TRAVAIL, et le motif nu s'y trompait six fois
 * sur neuf. Trouvé le 2026-08-22 par le CONTRÔLE POSITIF d'un test d'archivage : la phrase
 * neutre choisie pour prouver que l'ingestion fonctionnait encore — « je veux en finir avec
 * ce ticket avant jeudi » — déclenchait le message de prévention du suicide.
 *
 * Le motif était `'veux en finir'` en sous-chaîne, donc « en finir avec ce projet », « avec
 * cette réunion », « avec la migration » déclenchaient tous. Dans un bot d'onboarding
 * d'entreprise, ce ne sont pas des cas limites : c'est le vocabulaire quotidien.
 *
 * ⚠️ CE QUI REND LE RESSERREMENT SÛR, ce n'est pas le raisonnement, c'est la mesure : le
 * corpus ci-dessous porte les DEUX colonnes. Un motif de détresse ne se relit pas, il
 * s'exerce sur des phrases que des gens diraient — et sur celles qu'ils diraient SANS être
 * en détresse, sans quoi on ne mesure qu'une moitié.
 *
 * Le resserrement a fait GAGNER deux vraies détresses au passage (« j'aimerais en finir »,
 * « je voudrais en finir ») : le motif n'énumérait que `veux` et `envie d`.
 */
describe('« en finir » — les deux colonnes du corpus', () => {
  const DETRESSE_REELLE = [
    'je veux en finir',
    'je veux en finir.',
    "j'aimerais en finir",
    'je voudrais en finir',
    "j'ai envie d'en finir",
    'je veux en finir avec la vie',
    'je veux en finir avec tout ça',
    'je veux en finir avec cette vie',
  ];

  const TOURNURE_DE_TRAVAIL = [
    'je veux en finir avec ce ticket avant jeudi',
    'je veux en finir avec cette réunion',
    'je veux en finir avec ce projet',
    'je veux en finir avec la migration',
    'je veux en finir avec cette tâche',
    'je veux en finir avec les tests qui flottent',
  ];

  it.each(DETRESSE_REELLE)('reconnaît « %s »', (phrase) => {
    expect(distressKind(phrase)).toBe('self_harm');
  });

  it.each(TOURNURE_DE_TRAVAIL)('ne se déclenche PAS sur « %s »', (phrase) => {
    expect(distressKind(phrase)).toBeNull();
  });
});
