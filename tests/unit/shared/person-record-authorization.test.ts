import { describe, it, expect } from 'vitest';
import {
  buildSlackRequestContext,
  canReadPersonRecord,
} from '../../../src/shared/slack-request-context';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT QUE CES TESTS EXISTENT POUR INTERDIRE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Audit du 2026-08-13 : `getEmployeeProfile`, `getTaskList` et `getNotificationHistory` ne
 * contenaient AUCUNE référence au demandeur. N'importe quel membre du workspace obtenait le
 * dossier RH complet d'un collègue — département, poste, date d'entrée, manager, avancement
 * d'intégration, tâches, historique des notifications reçues.
 *
 * Et l'UUID n'était pas un secret : `findEmployeeByEmail` le rend depuis une simple adresse.
 * La chaîne « email d'un collègue → UUID → dossier » était ouverte en deux messages.
 */

const ME = 'd20df236-5c24-42a5-b205-d0d738d34fb4';
const SOMEONE_ELSE = 'd36b78dc-a039-4160-b86a-bd3d2a722b6c';

const context = (options: { employeeId?: string; accessLevel?: 'denied' | 'readonly' | 'full' }) =>
  buildSlackRequestContext({
    channel: 'D0MOCKDM01',
    slackUserId: 'U0BJBDGTJUD',
    ...options,
  });

describe('canReadPersonRecord — son propre dossier', () => {
  it('autorise la lecture de son propre dossier, même en accès restreint', () => {
    // ⚠️ La comparaison passe AVANT le niveau, délibérément. Sans cela, activer
    // l'application couperait chacun de son PROPRE parcours d'intégration — soit
    // exactement la fonction que ce produit existe pour rendre.
    const ctx = context({ employeeId: ME, accessLevel: 'readonly' });

    expect(canReadPersonRecord(ctx, ME)).toBe(true);
  });

  it('autorise aussi en accès `denied` : son dossier reste le sien', () => {
    const ctx = context({ employeeId: ME, accessLevel: 'denied' });

    expect(canReadPersonRecord(ctx, ME)).toBe(true);
  });
});

describe('canReadPersonRecord — le dossier de quelqu’un d’autre', () => {
  it('REFUSE un demandeur en lecture seule', () => {
    const ctx = context({ employeeId: ME, accessLevel: 'readonly' });

    expect(canReadPersonRecord(ctx, SOMEONE_ELSE)).toBe(false);
  });

  it('REFUSE un demandeur explicitement écarté', () => {
    const ctx = context({ employeeId: ME, accessLevel: 'denied' });

    expect(canReadPersonRecord(ctx, SOMEONE_ELSE)).toBe(false);
  });

  it('autorise un demandeur de niveau `full`', () => {
    // C'est la règle déjà appliquée par `getUserConversations` à la mémoire d'autrui et par
    // `canPerformSideEffects` aux effets de bord. On n'en crée pas une troisième.
    const ctx = context({ employeeId: ME, accessLevel: 'full' });

    expect(canReadPersonRecord(ctx, SOMEONE_ELSE)).toBe(true);
  });

  it('REFUSE un demandeur restreint qui n’a AUCUNE fiche employé', () => {
    // Cas courant et non cas limite : cinq humains dans ce workspace, une seule fiche. Sans
    // fiche, aucune lecture ne peut être reconnue comme « la sienne » — le niveau décide seul.
    const ctx = context({ accessLevel: 'readonly' });

    expect(canReadPersonRecord(ctx, SOMEONE_ELSE)).toBe(false);
  });
});

describe('canReadPersonRecord — les chemins SANS demandeur Slack', () => {
  /**
   * ⚠️ Le point délicat, et le même arbitrage que `canPerformSideEffects` mot pour mot :
   * playground, workflows, route HTTP et tests n'ont pas de demandeur. Refuser par absence
   * couperait tous ces appelants d'un coup. L'absence n'est pas un refus — c'est un chemin où
   * la question ne se pose pas.
   */
  it('autorise quand il n’y a pas de contexte Slack du tout', () => {
    expect(canReadPersonRecord(undefined, SOMEONE_ELSE)).toBe(true);
    expect(canReadPersonRecord(null, SOMEONE_ELSE)).toBe(true);
    expect(canReadPersonRecord({}, SOMEONE_ELSE)).toBe(true);
  });

  it('autorise quand le niveau n’a pas été évalué', () => {
    // `undefined` signifie « non évalué », jamais « autorisé par défaut » — mais le seul
    // producteur qui omette ce champ est un chemin hors Slack.
    const ctx = context({ employeeId: ME });

    expect(canReadPersonRecord(ctx, SOMEONE_ELSE)).toBe(true);
  });

  /**
   * ⚠️ HÉRITAGE DU MODE OBSERVATION — la limite à connaître avant de conclure quoi que ce
   * soit de cette fonction.
   *
   * Le niveau porté par le contexte est déjà l'`effective` calculé par `SlackAccessGuard`,
   * qui rend `full` à TOUT LE MONDE tant que `AUTHZ_ENFORCE` n'est pas posé. Tant que
   * l'application n'est pas activée, cette frontière ne refuse donc RIEN. C'est délibéré —
   * ces flux existaient avant elle — mais ce test est là pour que personne ne lise les cinq
   * tests précédents comme la preuve que la production est protégée.
   */
  it('laisse tout passer quand le garde applique le mode observation', () => {
    const asObserved = context({ employeeId: ME, accessLevel: 'full' });

    expect(canReadPersonRecord(asObserved, SOMEONE_ELSE)).toBe(true);
  });
});
