/**
 * « NON ÉVALUÉ » N'EST PAS « AUTORISÉ ».
 *
 * Défaut relevé le 2026-08-20 : `mayTouchRecord` rendait `true` dès que `accessLevel` valait
 * `undefined`. Or c'est exactement ce que rend `evaluateAccess` quand la décision n'a PAS pu
 * être prise :
 *
 *   slack-events.handler.ts   `if (!guard) return undefined;`        ← et AUCUN log
 *   slack-events.handler.ts   `catch { … return undefined; }`        ← garde en panne
 *
 * Une panne PARTIELLE de l'annuaire — pas une panne totale, qui masquerait le défaut en
 * faisant échouer la lecture elle-même — accordait donc l'équivalent de `full` à tout le
 * monde, y compris avec `AUTHZ_ENFORCE=true`. Et le cas le plus probable des deux, le garde
 * non câblé, ne journalisait rien du tout.
 *
 * ⚠️ CE QUI NE CHANGE PAS, et qu'il faut préserver :
 *
 *   - HORS SLACK (playground, route HTTP, workflow, test), `readSlackContext` rend
 *     `undefined` et la garde reste passante. C'est le cas NOMINAL de ces chemins, il est
 *     documenté, et le fermer couperait le produit de lui-même.
 *   - SON PROPRE DOSSIER reste toujours accessible : la comparaison sur `employees.id` a
 *     lieu AVANT toute lecture du niveau. Sans cela, `readonly` étant le cas nominal de tout
 *     le monde depuis le 2026-08-20, chacun perdrait le droit d'agir sur son propre parcours
 *     — et la frontière redeviendrait inactivable.
 *
 * La distinction est donc entre « il n'y a pas de contexte Slack » (passant, nominal) et
 * « il y a un contexte Slack mais aucune décision » (restrictif, anormal).
 */
import { describe, it, expect } from 'vitest';

import {
  buildSlackRequestContext,
  canReadPersonRecord,
  canPerformSideEffects,
} from '../../../src/shared/slack-request-context';

const MOI = '11111111-1111-4111-8111-111111111111';
const AUTRUI = '22222222-2222-4222-8222-222222222222';

function contexte(options: { accessLevel?: 'full' | 'readonly'; employeeId?: string }) {
  return buildSlackRequestContext({
    channel: 'D0BM123',
    slackUserId: 'U0BM123',
    ...(options.accessLevel ? { accessLevel: options.accessLevel } : {}),
    ...(options.employeeId ? { employeeId: options.employeeId } : {}),
  });
}

describe('contexte Slack sans décision d’autorisation', () => {
  it("REFUSE le dossier d'autrui — une non-décision n'accorde rien", () => {
    expect(canReadPersonRecord(contexte({ employeeId: MOI }), AUTRUI)).toBe(false);
  });

  it("REFUSE d'agir sur le dossier d'autrui", () => {
    expect(canPerformSideEffects(contexte({ employeeId: MOI }), AUTRUI)).toBe(false);
  });

  it('accorde TOUJOURS son propre dossier, décision ou non', () => {
    // La comparaison d'identité précède la lecture du niveau. C'est ce qui rend la
    // frontière activable sans couper chacun de son propre parcours.
    expect(canReadPersonRecord(contexte({ employeeId: MOI }), MOI)).toBe(true);
    expect(canPerformSideEffects(contexte({ employeeId: MOI }), MOI)).toBe(true);
  });
});

describe('ce que le correctif ne doit PAS casser', () => {
  it('reste passant HORS Slack — playground, route HTTP, workflow, test', () => {
    // `readSlackContext` rend `undefined` sur ces chemins : c'est leur cas NOMINAL, et les
    // tools y dégradent proprement. Fermer ici couperait le produit de lui-même.
    expect(canReadPersonRecord(undefined, AUTRUI)).toBe(true);
    expect(canPerformSideEffects(undefined, AUTRUI)).toBe(true);
  });

  it('laisse le manager lire le dossier de tout le monde', () => {
    expect(canReadPersonRecord(contexte({ accessLevel: 'full', employeeId: MOI }), AUTRUI)).toBe(
      true,
    );
  });

  it('refuse le dossier d’autrui à un `readonly`, comme avant', () => {
    expect(
      canReadPersonRecord(contexte({ accessLevel: 'readonly', employeeId: MOI }), AUTRUI),
    ).toBe(false);
  });
});
