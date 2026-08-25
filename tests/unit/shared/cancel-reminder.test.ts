import { describe, it, expect } from 'vitest';

import {
  requestsReminderCancellation,
  reminderCancelChoiceReply,
  reminderCancelledReply,
  remindersCancelledReply,
  pickReminderToCancel,
} from '../../../src/shared/cancel-reminder';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ANNULER UN RAPPEL — UN CORPUS À DEUX COLONNES, JAMAIS UN RAISONNEMENT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **L'ASYMÉTRIE VA DANS L'AUTRE SENS QUE `profile-request.ts`, ET C'EST ELLE QUI DICTE LA
 * SÉVÉRITÉ.** Un faux positif annule un rappel que personne ne reverra — la panne SILENCIEUSE
 * que ce dépôt traque partout. Un faux négatif laisse partir un rappel dont on ne voulait
 * plus : bruyant, visible, corrigible d'un message. On s'abstient donc VERS le refus.
 *
 * ⚠️ **LE PIÈGE PROPRE À CE PRÉDICAT : « rappelle » CONTIENT « rappel ».** Chercher l'objet en
 * SOUS-CHAÎNE ferait mordre « annule la réunion et rappelle-moi jeudi » — une phrase qui
 * demande justement de POSER un rappel. L'objet est donc comparé MOT À MOT sur le texte
 * normalisé. Même famille que `\b` en ASCII sur `bloqué` : un motif qui échoue (ou mord) en
 * silence sur du vocabulaire courant est pire qu'un motif absent.
 *
 * Les deux colonnes sont exercées : ce que dirait quelqu'un qui veut annuler, et ce que dirait
 * quelqu'un qui ne le veut pas. N'en exercer qu'une moitié ne mesure rien.
 */

const CANCELS_ONE: readonly string[] = [
  'annule le rappel',
  'Annule le rappel de jeudi',
  'annule ce rappel',
  'supprime le rappel',
  'efface le rappel de jeudi',
  'retire le rappel',
  'enlève le rappel de jeudi',
  'oublie le rappel de jeudi',
  'annule la relance',
  'Peux-tu annuler le rappel ?',
  'tu peux annuler le rappel stp',
  'merci de supprimer le rappel',
  'Annule le rappel !',
];

const CANCELS_ALL: readonly string[] = [
  'annule tous mes rappels',
  'supprime mes rappels',
  'annule toutes mes relances',
  'efface tous les rappels',
];

const SPARED: readonly string[] = [
  // — la négation, séparée du verbe ou non
  "n'annule pas le rappel",
  'ne supprime surtout pas le rappel',
  'je ne veux pas annuler le rappel',
  // — une QUESTION n'est pas un ordre
  'tu vas annuler le rappel ?',
  'pourquoi as-tu annulé le rappel ?',
  'est-ce que je peux annuler un rappel ?',
  // — le piège de la sous-chaîne : ces phrases DEMANDENT un rappel
  'annule la réunion et rappelle-moi jeudi',
  'rappelle-moi jeudi de relire le compte rendu',
  // — un autre objet que le rappel
  'annule la réunion de jeudi',
  'annule ma demande de congés',
  'supprime mon compte',
  // — sans objet nommé, on ne devine pas
  'annule-le',
  'annule tout',
];

describe('requestsReminderCancellation — ce qui doit être reconnu', () => {
  it.each(CANCELS_ONE)('reconnaît « %s » et vise le dernier rappel', (phrase) => {
    expect(requestsReminderCancellation(phrase)).toBe('last');
  });

  it.each(CANCELS_ALL)('reconnaît « %s » et vise TOUS les rappels', (phrase) => {
    expect(requestsReminderCancellation(phrase)).toBe('all');
  });
});

describe('requestsReminderCancellation — ce qui doit être épargné', () => {
  it.each(SPARED)('ne mord pas sur « %s »', (phrase) => {
    expect(requestsReminderCancellation(phrase)).toBeNull();
  });

  it('ne mord pas sur un texte vide ou absent', () => {
    expect(requestsReminderCancellation('')).toBeNull();
    expect(requestsReminderCancellation(undefined)).toBeNull();
    expect(requestsReminderCancellation(null)).toBeNull();
  });

  it('ne mord pas sur un texte long — un ordre tient en une phrase', () => {
    expect(requestsReminderCancellation(`annule le rappel ${'x'.repeat(400)}`)).toBeNull();
  });
});

describe('les réponses NOMMENT ce qui a été annulé', () => {
  it('cite le sujet et le jour — une erreur devient visible au tour même', () => {
    const reply = reminderCancelledReply('Rappel : relire le compte rendu', 'jeudi 27 août 2026');
    expect(reply).toContain('relire le compte rendu');
    expect(reply).toContain('jeudi 27 août 2026');
  });

  it('reste juste quand le jour est illisible', () => {
    const reply = reminderCancelledReply('Rappel : relire le compte rendu', null);
    expect(reply).toContain('relire le compte rendu');
  });

  it('accorde le compte au pluriel comme au singulier', () => {
    expect(remindersCancelledReply(1)).toContain('1 rappel');
    expect(remindersCancelledReply(3)).toContain('3 rappels');
  });
});

describe('sur ambiguïté, on ne choisit pas', () => {
  const CANDIDATES = [
    { subject: 'Rappel : relire le compte rendu', deliveredOn: 'jeudi 27 août 2026' },
    { subject: 'Rappel : relire les guidelines', deliveredOn: 'lundi 31 août 2026' },
  ];

  it('énumère les candidats au lieu d’en désigner un', () => {
    const reply = reminderCancelChoiceReply(CANDIDATES);
    expect(reply).toContain('relire le compte rendu');
    expect(reply).toContain('relire les guidelines');
    expect(reply).toContain('jeudi 27 août 2026');
    expect(reply).toContain('lundi 31 août 2026');
  });

  it('n’annonce JAMAIS une annulation dans le message qui demande laquelle', () => {
    // Le pire cas : la personne lit « annulé » dans une phrase qui pose une question.
    expect(reminderCancelChoiceReply(CANDIDATES)).not.toMatch(/c'est annulé|j'ai annulé/i);
  });
});

describe('aucun markdown de style « ** » — les textes en dur ne passent par aucun filtre', () => {
  const ALL = [
    reminderCancelledReply('Sujet', 'jeudi'),
    remindersCancelledReply(2),
    reminderCancelChoiceReply([{ subject: 'Sujet', deliveredOn: 'jeudi' }]),
  ];

  it.each(ALL)('n’utilise pas la syntaxe markdown du gras', (text) => {
    expect(text).not.toContain('**');
  });
});

/**
 * ⚠️ **SANS CECI, LA QUESTION SERAIT UNE BOUCLE SANS SORTIE.** Marcel demande « lequel ? », la
 * personne répond « annule celui de jeudi » — et le prédicat rend `last` une fois de plus, donc
 * la même question repart. C'est exactement la forme que `PROFILE_EMAIL_TAKEN_REPLY` existe
 * pour fermer : poser une question dont aucune réponse ne peut sortir.
 *
 * La désignation est donc DÉRIVÉE de ce que Marcel vient d'afficher — le jour et le sujet —
 * jamais d'un identifiant demandé à qui que ce soit. Zéro token : c'est du code.
 */
describe('pickReminderToCancel — désigner par un mot de la phrase', () => {
  const JEUDI = { subject: 'Rappel : relire le compte rendu', deliveredOn: 'jeudi 27 août 2026' };
  const LUNDI = { subject: 'Rappel : relire les guidelines', deliveredOn: 'lundi 31 août 2026' };

  it('un seul rappel : aucune désignation nécessaire', () => {
    expect(pickReminderToCancel([JEUDI], 'annule le rappel')).toEqual({ chosen: JEUDI });
  });

  it('le JOUR suffit à désigner', () => {
    expect(pickReminderToCancel([JEUDI, LUNDI], 'annule le rappel de jeudi')).toEqual({
      chosen: JEUDI,
    });
  });

  it('la DATE chiffrée suffit aussi', () => {
    expect(pickReminderToCancel([JEUDI, LUNDI], 'annule le rappel du 31')).toEqual({
      chosen: LUNDI,
    });
  });

  it('un mot du SUJET suffit', () => {
    expect(pickReminderToCancel([JEUDI, LUNDI], 'annule le rappel sur les guidelines')).toEqual({
      chosen: LUNDI,
    });
  });

  it('sans rien de distinctif, on ne choisit PAS', () => {
    expect(pickReminderToCancel([JEUDI, LUNDI], 'annule le rappel')).toEqual({
      ambiguous: [JEUDI, LUNDI],
    });
  });

  it('un mot commun aux deux ne désigne rien', () => {
    // « relire » est dans les deux sujets : le retenir désignerait au hasard.
    expect(pickReminderToCancel([JEUDI, LUNDI], 'annule le rappel de relire')).toEqual({
      ambiguous: [JEUDI, LUNDI],
    });
  });

  it('aucun rappel : rien à désigner', () => {
    expect(pickReminderToCancel([], 'annule le rappel')).toEqual({ ambiguous: [] });
  });

  it('les mots de la demande elle-même ne désignent rien', () => {
    // « annule », « rappel », « le », « mes » sont dans toutes les demandes : s'ils comptaient,
    // le premier candidat gagnerait toujours, et le choix serait un tirage déguisé.
    const JOUR = { subject: 'Annuler le rappel', deliveredOn: 'mardi 1 septembre 2026' };
    expect(pickReminderToCancel([JOUR, LUNDI], 'annule le rappel')).toEqual({
      ambiguous: [JOUR, LUNDI],
    });
  });
});
