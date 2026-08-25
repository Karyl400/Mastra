import { describe, it, expect } from 'vitest';

import { buildSnapshot } from '../../../src/features/dashboard/domain/services/dashboard-snapshot';
import type { DashboardFacts } from '../../../src/features/dashboard/domain/ports/dashboard-facts.repository';
import { missingMetrics } from '../../../src/features/dashboard/domain/services/metric-catalogue';

const FACTS: DashboardFacts = {
  directoryPeople: 7,
  directoryLinked: 2,
  employeeRecords: 2,
  progressCompleted: 1,
  interviewsFilled: 1,
  completionDurationsMs: [600_000, 1_800_000, 1_200_000],
  userTurns: 40,
  assistantTurns: 38,
  assistantTurnsFollowedByUser: 19,
  assistantTurnsAnswerable: 25,
  distinctUsers: 4,
  humanReplyDelaysMs: [60_000, 120_000, 900_000],
  modelHandledMessages: 24,
  agentRuns: 24,
  agentRunsFailed: 3,
  injectionsBlocked: 4,
  requalifiedResponses: 1,
  latenciesMs: [2_000, 4_000, 12_000],
  toolCallCounts: { findPersonByName: 5, generateDocument: 2 },
  notificationsTotal: 10,
  notificationsFailed: 2,
  documentsTotal: 8,
  documentsDelivered: 6,
  auditFailures: 3,
  rateLimited: 5,
  activeUsers: 1,
  openConversations: 2,
  feed: [],
  unreadableTables: [],
};

const read = (key: string) => {
  const found = buildSnapshot(FACTS).find((m) => m.key === key);
  if (!found) throw new Error(`métrique absente du catalogue : ${key}`);
  return found.reading;
};

describe('buildSnapshot — ce qui est mesurable est mesuré', () => {
  it('rapporte le taux de complétion aux PERSONNES, pas aux dossiers', () => {
    // 1 parcours terminé sur 7 personnes = 14 %. Rapporté aux 2 dossiers, il vaudrait 50 % —
    // un chiffre flatteur qui masquerait les 5 personnes sans dossier.
    expect(read('onboarding.completionRate')).toEqual({
      available: true,
      value: 14,
      detail: '1 / 7',
    });
  });

  it('rend la MÉDIANE du délai humain, jamais la moyenne', () => {
    // 60 s, 120 s, 900 s → médiane 120 s = 2 min. La moyenne vaudrait 6 min, tirée par le fil
    // repris une heure plus tard : le chiffre deviendrait illisible.
    expect(read('engagement.replyDelay')).toEqual({
      available: true,
      value: 2,
      detail: '3 mesures',
    });
  });

  it('estime la part sans modèle, et le dit dans le détail', () => {
    // 40 tours user, 24 messages passés par un modèle → 16 sur 40 = 40 %.
    const reading = read('ai.zeroTokenShare');
    expect(reading.available).toBe(true);
    if (reading.available) {
      expect(reading.value).toBe(40);
      expect(reading.detail).toMatch(/estimation/i);
    }
  });

  it('ne divise JAMAIS par zéro, et dit « pas encore » et non « pas mesurable »', () => {
    // Sur une base neuve, tous les dénominateurs valent 0. Rendre 0 % ferait lire « aucune
    // livraison ne passe » là où il n'y a eu aucune livraison — même défaut que « satisfaction :
    // 0 % » sur une question jamais posée.
    //
    // ⚠️ Et la RAISON compte autant que l'absence de valeur : `no_data_yet` dit au lecteur que le
    // produit sait mesurer ceci et qu'il n'y a rien encore. `not_persisted` dirait qu'il ne sait
    // pas. Les confondre transformerait une base neuve en diagnostic de panne.
    const empty = buildSnapshot({ ...FACTS, notificationsTotal: 0, directoryPeople: 0 });
    expect(empty.find((m) => m.key === 'health.notificationFailure')?.reading).toEqual({
      available: false,
      gap: 'no_data_yet',
    });
    expect(empty.find((m) => m.key === 'onboarding.completionRate')?.reading).toEqual({
      available: false,
      gap: 'no_data_yet',
    });
  });

  it('NOMME l’incohérence au lieu de la plafonner', () => {
    // Relevé en tirant la base locale : 93 dossiers pour 1 personne connue de l'annuaire, soit
    // 9 300 %. Ramener le chiffre à 100 % le rendrait présentable et masquerait le seul fait
    // intéressant — que les deux tables ne parlent pas de la même population.
    const skewed = buildSnapshot({ ...FACTS, employeeRecords: 93, directoryPeople: 1 });
    const reading = skewed.find((m) => m.key === 'engagement.profileActivation')?.reading;
    expect(reading?.available).toBe(true);
    if (reading?.available) {
      expect(reading.value).toBe(9300);
      expect(reading.detail).toMatch(/incohérent/);
    }
  });

  it('l’entonnoir décroît, et il compte des personnes réelles', () => {
    const funnel = buildSnapshot(FACTS).find((m) => m.key === 'onboarding.funnel');
    expect(funnel?.reading).toEqual({
      available: true,
      value: 7,
      detail: '7 → 2 → 2 → 1 → 1',
    });
  });

  it('DIT quand un étage dépasse le précédent — cas relevé en production', () => {
    // Tirage du 2026-08-25 sur la Turso de production : `8 → 2 → 2 → 3 → 1`. Trois parcours
    // marqués terminés pour deux dossiers vivants — la troisième personne est soft-deleted,
    // et `onboarding_progress` ne filtre pas `deleted_at`. Un entonnoir qui remonte n'est pas
    // un entonnoir : le taire le rendrait lisible comme une progression normale.
    const skewed = buildSnapshot({ ...FACTS, progressCompleted: 3, employeeRecords: 2 });
    const reading = skewed.find((m) => m.key === 'onboarding.funnel')?.reading;
    expect(reading?.available).toBe(true);
    if (reading?.available) {
      expect(reading.detail).toContain('7 → 2 → 2 → 3 → 1');
      expect(reading.detail).toMatch(/incohérent/);
    }
  });
});

describe('buildSnapshot — ce qui n’est pas mesurable ne reçoit PAS de valeur', () => {
  it('toutes les métriques sans source restent indisponibles, quelles que soient les données', () => {
    const snapshot = buildSnapshot(FACTS);
    for (const spec of missingMetrics()) {
      const resolved = snapshot.find((m) => m.key === spec.key);
      expect(resolved?.reading.available).toBe(false);
    }
  });

  it('une métrique indisponible ne porte aucun champ `value`', () => {
    const snapshot = buildSnapshot(FACTS);
    for (const m of snapshot) {
      if (!m.reading.available) expect(m.reading).not.toHaveProperty('value');
    }
  });

  it('le snapshot couvre le catalogue entier — aucune métrique n’est silencieusement omise', () => {
    const snapshot = buildSnapshot(FACTS);
    expect(new Set(snapshot.map((m) => m.key)).size).toBe(snapshot.length);
  });
});

/**
 * ⚠️ UNE TABLE MANQUANTE NE DOIT PAS ÉTEINDRE LA PAGE — cas RÉEL, rencontré en écrivant.
 *
 * `onboarding_interview` a été créée par un DDL appliqué directement sur la Turso de production ;
 * une base locale ou neuve ne la porte pas. La première version de la lecture lançait ses onze
 * requêtes dans un `Promise.all` nu : `no such table` tuait les onze, et le tableau de bord
 * entier tombait en désignant sa cause nulle part.
 *
 * La dégradation est PAR MÉTRIQUE, et elle est DÉRIVÉE : chaque métrique déclare déjà les tables
 * dont elle sort (`source.from`), donc il n'y a aucune liste à tenir à jour en face.
 */
describe('buildSnapshot — une table illisible ne tue que ses propres métriques', () => {
  const degraded = buildSnapshot({ ...FACTS, unreadableTables: ['onboarding_interview'] });
  const readingOf = (key: string) => degraded.find((m) => m.key === key)?.reading;

  it('marque la métrique qui en dépend, avec sa propre raison', () => {
    expect(readingOf('onboarding.interviews')).toEqual({ available: false, gap: 'read_failed' });
  });

  it('laisse intactes les métriques qui n’en dépendent pas', () => {
    expect(readingOf('engagement.messages')).toEqual({ available: true, value: 40 });
    expect(readingOf('health.rateLimited')?.available).toBe(true);
  });

  it('l’entonnoir, qui traverse quatre tables, tombe avec la table manquante', () => {
    // Il pourrait n'afficher que quatre étages sur cinq. On préfère « indisponible » : un
    // entonnoir amputé de son dernier étage se lit comme un entonnoir complet où personne
    // n'arrive au bout — exactement le contresens que ce fichier existe pour empêcher.
    expect(readingOf('onboarding.funnel')).toEqual({ available: false, gap: 'read_failed' });
  });
});

/**
 * ⚠️ TROIS MÉTRIQUES ONT CESSÉ D'ÊTRE DES LACUNES LE 2026-08-25, et c'est le sens du garde-fou
 * posé dans `metric-catalogue.test.ts` : « un manque nommé doit pouvoir cesser d'être un
 * manque ». La latence, les réponses requalifiées et l'usage des outils étaient mesurés à
 * l'exécution puis JETÉS dans des logs Vercel remis à zéro à chaque redéploiement. Une seule
 * écriture — `AGENT_RUN` — les rend comptables.
 */
describe('ce que `AGENT_RUN` a rendu mesurable', () => {
  const read = (key: string) => buildSnapshot(FACTS).find((m) => m.key === key)?.reading;

  it('rend la MÉDIANE de latence, jamais la moyenne', () => {
    // 2 s, 4 s, 12 s → médiane 4 s. La moyenne vaudrait 6 s, tirée par le run tombé sur le
    // repli Mistral (11,7 s mesurées en production). C'est le seuil des ~10 s qu'on surveille,
    // et une moyenne le franchirait pour un seul run lent sur vingt rapides.
    expect(read('ai.latency')).toEqual({ available: true, value: 4000, detail: '3 runs' });
  });

  it('compte les réponses requalifiées, rapportées au nombre de runs', () => {
    expect(read('ai.unsupportedClaims')).toEqual({
      available: true,
      value: 1,
      detail: 'sur 24 runs',
    });
  });

  it('détaille les appels par outil, du plus fréquent au moins fréquent', () => {
    const reading = read('ai.toolCalls');
    expect(reading?.available).toBe(true);
    if (reading?.available) {
      expect(reading.value).toBe(7);
      expect(reading.detail).toBe('findPersonByName 5 · generateDocument 2');
    }
  });

  it('dit « pas encore » plutôt que zéro quand aucun run n’a été enregistré', () => {
    const empty = buildSnapshot({ ...FACTS, latenciesMs: [], toolCallCounts: {} });
    expect(empty.find((m) => m.key === 'ai.latency')?.reading).toEqual({
      available: false,
      gap: 'no_data_yet',
    });
    expect(empty.find((m) => m.key === 'ai.toolCalls')?.reading).toEqual({
      available: false,
      gap: 'no_data_yet',
    });
  });
});

/**
 * ⚠️ QUATRE INJECTIONS BLOQUÉES S'AFFICHAIENT COMME QUATRE PANNES — relevé en production le
 * 2026-08-25, sur la campagne d'attaques.
 *
 * Le journal disait vrai (`status: 'failure'`, `Input rejected: injection attempt detected`,
 * 0 à 2 ms) et le tableau de bord le lisait de travers. Compter un refus RÉUSSI comme un échec
 * technique est la même famille de défaut que tout le reste de ce module : un chiffre qui a
 * l'air d'une mesure et qui dit autre chose que ce qu'on lit.
 *
 * Le coût aurait été concret : on cherche une panne là où le garde-fou a fait son travail.
 */
describe('un refus d’injection n’est PAS une panne', () => {
  const read = (key: string) => buildSnapshot(FACTS).find((m) => m.key === key)?.reading;

  it('compte les injections séparément des échecs', () => {
    expect(read('ai.injectionsBlocked')).toEqual({
      available: true,
      value: 4,
      detail: 'sur 24 runs',
    });
    expect(read('ai.runFailures')).toEqual({ available: true, value: 3, detail: 'sur 24 runs' });
  });
});
