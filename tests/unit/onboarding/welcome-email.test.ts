import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { buildWelcomeEmail } from '../../../src/features/onboarding/domain/services/welcome-email';
import { ASSISTANT_NAME } from '../../../src/shared/assistant-identity';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « que les emails se rapprochent le plus possible de la réalité de
 *   l'utilisateur et ne soient pas simplement génériques »
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Deux défauts distincts, et le premier est le plus grave.
 *
 * L'ancien texte PROMETTAIT « les accès à nos outils ainsi que votre planning de première
 * semaine ». Il n'existe ni provisioning ni planning dans ce système. C'était le tout premier
 * message de l'entreprise à un arrivant, et il ouvrait sur une promesse que rien ne tient.
 *
 * Et il était générique alors que `position` et `startDate` étaient SAISIS dans la modale,
 * puis jetés au passage d'un schéma d'étape, deux étapes avant l'email.
 */

const BASE = { firstName: 'Awa', lastName: 'TRAORE' };

describe('buildWelcomeEmail — ne promet que ce qui existe', () => {
  it('ne promet NI accès aux outils NI planning', () => {
    // Garde-fou de non-retour : ces deux phrases reviendraient à la première relecture qui
    // les trouverait « accueillantes » — c'est ce qui les avait fait écrire.
    const mail = buildWelcomeEmail({ ...BASE, position: 'Backend Developer' });

    expect(mail.body).not.toMatch(/accès à nos outils/i);
    expect(mail.body).not.toMatch(/planning/i);
    expect(mail.body).not.toMatch(/première semaine/i);
  });

  it('la seule projection dans le futur est VRAIE — le DM part réellement', () => {
    // ⚠️ L'assertion portait sur « compléter ton profil », qui était le LIBELLÉ D'UN BOUTON
    // annoncé par cet email. Ce bouton n'existe plus depuis le 2026-08-19 : celui que la
    // personne reçoit dit « C'est fait », et `buildProfileButtonBlock` n'a plus aucun
    // appelant. Le test verrouillait donc une promesse devenue fausse — et son commentaire
    // affirmait précisément l'inverse.
    //
    // Ce qui reste vrai et doit le rester : `handleTeamJoin` envoie bien un DM. On vérifie
    // l'existence du DM, pas le libellé d'un bouton — c'est l'invariant, le reste est un
    // détail d'interface qui a déjà changé une fois.
    const mail = buildWelcomeEmail(BASE);
    // ⚠️ Le message NOMME l'assistant depuis le 2026-08-24, il ne le désigne plus par sa
    // nature (« notre bot »). L'expéditeur de cet email s'appelle désormais Marcel : la
    // personne lisait « notre bot » puis recevait un DM signé Marcel, soit deux
    // interlocuteurs pour un seul. L'assertion compare à `ASSISTANT_NAME`, jamais au
    // littéral — un renommage doit traverser sans réécrire ce test.
    expect(mail.body).toContain(`message direct de ${ASSISTANT_NAME} sur Slack`);
    expect(mail.body).toMatch(/dossier/i);
  });
});

describe('buildWelcomeEmail — la réalité de la personne', () => {
  /**
   * ⚠️ HORLOGE FIGÉE — sans quoi ce test rougissait le 2026-09-01 (2026-08-22).
   *
   * `isFutureDay` compare la date de début à `new Date()` RÉEL et n'a aucun point
   * d'injection ; la phrase « On t'attend le … » n'est émise que si la date est future. Le
   * matin du 1ᵉʳ septembre 2026, l'égalité tue le `>`, la phrase disparaît et l'assertion
   * sur « septembre 2026 » tombe — sans qu'aucune ligne de code ait bougé.
   *
   * On fige ici plutôt que de dériver la date de `now`, parce que le libellé attendu est un
   * MOIS écrit en toutes lettres : le dériver obligerait le test à recalculer le mois, donc
   * à réimplémenter ce qu'il vérifie.
   */
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cite le poste et le premier jour EN TOUTES LETTRES — sans l’équipe', () => {
    const mail = buildWelcomeEmail({
      ...BASE,
      position: 'Backend Developer',
      startDate: '2026-09-01T00:00:00.000Z',
    });

    // Sans exclamation : le bloc STYLE l'interdit au modèle depuis qu'on a mesuré que « les
    // exclamations arrivaient précisément dans les phrases où l'agent ne faisait rien ». Un
    // gabarit n'a pas de raison d'y échapper.
    expect(mail.subject).toBe('Bienvenue chez Kisso Industries, Awa');
    expect(mail.body).toContain('Backend Developer');
    // ⚠️ Le DÉPARTEMENT a été retiré le 2026-08-20 : « les départements ne doivent plus
    // apparaître ». Le champ n'existe plus dans `WelcomeEmailInput`, donc il ne peut plus
    // revenir par une ligne ancienne.
    expect(mail.body).not.toContain('Engineering');
    // « 2026-09-01T00:00:00.000Z » ne dit rien à un arrivant ; « mardi 1 septembre 2026 » si.
    expect(mail.body).toContain('septembre 2026');
    expect(mail.body).not.toContain('2026-09-01T');
  });

  it('cite les canaux Slack où la personne sera réellement invitée', () => {
    const mail = buildWelcomeEmail({ ...BASE, channels: ['kisso-hq', 'engineering-chat'] });
    expect(mail.body).toContain('#kisso-hq');
    expect(mail.body).toContain('#engineering-chat');
  });

  it('OMET la phrase entière quand le champ manque — jamais de « N/A »', () => {
    // Même discipline que `buildWelcomeLetter`, dont « Département : N/A » a été retiré : un
    // intertitre suivi du vide se lit comme un oubli, pas comme une absence de réponse.
    const mail = buildWelcomeEmail(BASE);

    expect(mail.body).not.toMatch(/N\/A|non renseigné|undefined|null/i);
    expect(mail.body).not.toContain('Poste :');
    expect(mail.body).not.toContain('Premier jour :');
    // Sans aucun fait, le bloc entier disparaît — y compris son intertitre.
    expect(mail.body).not.toContain('Ce que nous avons enregistré');
  });

  it('OMET le premier jour si la date est illisible, au lieu de l’imprimer brute', () => {
    const mail = buildWelcomeEmail({ ...BASE, startDate: 'lundi prochain' });
    expect(mail.body).not.toContain('Premier jour');
    expect(mail.body).not.toContain('lundi prochain');
  });

  it('ÉCHAPPE le HTML — le poste vient d’une saisie humaine dans une modale', () => {
    const mail = buildWelcomeEmail({ ...BASE, position: '<img src=x onerror=alert(1)>' });

    expect(mail.body).not.toContain('<img');
    expect(mail.body).toContain('&lt;img');
  });

  it('invite à CORRIGER quand des faits sont affichés', () => {
    // Ces données ont été saisies par quelqu'un d'autre que l'intéressé : la seule personne
    // capable de repérer une erreur est celle qui reçoit l'email.
    const mail = buildWelcomeEmail({ ...BASE, position: 'Backend Developer' });
    expect(mail.body).toMatch(/inexact/i);
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « On t'attend le … » — une phrase d'ATTENTE ne vaut que pour l'avenir
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Relevé le 2026-08-19. Sur le chemin conversationnel — devenu le chemin PRINCIPAL depuis le
 * retrait des modales — `submitProfile` passe `startDateFromJoin(undefined, new Date())`, où
 * `joinedAt` est TOUJOURS `undefined` : la date de début vaut donc systématiquement
 * AUJOURD'HUI. Un salarié présent depuis six mois qui complète son dossier recevait « On
 * t'attend le mercredi 19 août 2026 ».
 *
 * ⚠️ La règle « un champ absent fait disparaître sa phrase » — la fierté de ce module — était
 * CONTOURNÉE, non pas violée : le champ n'est jamais absent, il est FABRIQUÉ deux couches plus
 * haut. C'est la forme la plus difficile à voir de cette famille de défaut, parce que chaque
 * module pris isolément se comporte correctement.
 *
 * ⚠️ On ne corrige PAS en rendant la date facultative : `employees.start_date` est `NOT NULL`
 * et le schéma du workflow exige `z.string().datetime()`. La corriger là demanderait un DDL en
 * production pour un gain de texte. La règle juste est locale et suffit : on n'ATTEND que ce
 * qui n'est pas encore arrivé.
 */
describe('buildWelcomeEmail — la date d’arrivée', () => {
  const inDays = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString();
  };

  it('annonce le premier jour quand il est À VENIR', () => {
    const mail = buildWelcomeEmail({ ...BASE, startDate: inDays(12) });
    expect(mail.body).toMatch(/On t’attend le|On t'attend le/);
  });

  it('OMET la phrase quand la date est AUJOURD’HUI — le cas fabriqué', () => {
    const mail = buildWelcomeEmail({ ...BASE, startDate: new Date().toISOString() });
    expect(mail.body).not.toMatch(/attend/i);
  });

  it('OMET la phrase quand la date est PASSÉE — le rattrapage d’un salarié déjà là', () => {
    const mail = buildWelcomeEmail({ ...BASE, startDate: inDays(-180) });
    expect(mail.body).not.toMatch(/attend/i);
  });
});
