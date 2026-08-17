import { describe, it, expect, vi } from 'vitest';

import { makeGetEmployeeProfile } from '../../../src/features/employee/application/tools/get-employee-profile';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * UNE ÉTAPE EN MOINS — le seul levier de coût qui compte vraiment
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Mesuré en production le 2026-08-15 sur « Quel est le profil de l'employé dont l'email est
 * X ? » : **3 étapes**, `findEmployeeByEmail` → `getEmployeeProfile` → réponse, pour
 * **4 711 tokens d'entrée**. L'entrée est CUMULATIVE — elle est réémise en entier à chaque
 * étape (1 417 + 1 559 + 1 735) — donc une étape épargnée vaut ≈ 1 500 tokens, soit près d'un
 * tiers du message, là où raboter le prompt en rend quelques dizaines.
 *
 * C'est exactement la doctrine du dépôt : « le poste de coût dominant n'est pas la TAILLE du
 * prompt mais le NOMBRE D'ÉTAPES ». Sur un budget qui se compte à la JOURNÉE (≈ 19 messages),
 * ce n'est pas une optimisation de confort.
 *
 * ⚠️ La frontière d'autorisation ne bouge PAS d'un pouce, et deux propriétés doivent tenir :
 *  - le chemin `employeeId` refuse toujours AVANT toute lecture en base ;
 *  - le chemin `email` ne devient pas un ORACLE — un demandeur non autorisé doit recevoir le
 *    MÊME verdict, que l'adresse désigne quelqu'un ou personne.
 */

const ME = 'd20df236-5c24-42a5-b205-d0d738d34fb4';
const SOMEONE_ELSE = 'd36b78dc-a039-4160-b86a-bd3d2a722b6c';

const employeeRow = {
  id: SOMEONE_ELSE,
  firstName: 'Awa',
  lastName: 'TRAORE',
  email: 'awa@kissohq.com',
  department: 'Engineering',
  position: 'Developer',
  startDate: '2026-09-01T00:00:00.000Z',
  status: 'pending',
  managerId: null,
};

/** Demandeur identifié mais SANS le niveau `full`. */
const restricted = {
  requestContext: buildSlackRequestContext({
    channel: 'D0MOCKDM01',
    slackUserId: 'U0BJBDGTJUD',
    employeeId: ME,
    accessLevel: 'readonly',
  }),
};

function tool(opts: { byId?: unknown; byEmail?: unknown; progress?: unknown } = {}) {
  const findById = vi.fn().mockResolvedValue(opts.byId ?? null);
  const findByEmail = vi.fn().mockResolvedValue(opts.byEmail ?? null);
  const findByEmployee = vi.fn().mockResolvedValue(opts.progress ?? null);
  return {
    tool: makeGetEmployeeProfile({ findById, findByEmail } as never, { findByEmployee } as never),
    findById,
    findByEmail,
  };
}

describe('getEmployeeProfile — résolution par email (une étape en moins)', () => {
  it('rend le profil depuis le seul email, SANS repasser par findById', async () => {
    const { tool: t, findById, findByEmail } = tool({ byEmail: employeeRow });

    const result = (await t.execute!({ email: 'awa@kissohq.com' } as never, {} as never)) as {
      found: boolean;
      employee?: { id: string; email: string };
    };

    expect(result.found).toBe(true);
    expect(result.employee?.id).toBe(SOMEONE_ELSE);
    expect(findByEmail).toHaveBeenCalledWith('awa@kissohq.com');
    // LE POINT DU TEST : la résolution ne coûte pas une lecture de plus. Si `findById` était
    // rappelé derrière, on aurait déplacé l'aller-retour au lieu de le supprimer.
    expect(findById).not.toHaveBeenCalled();
  });

  it('normalise l’adresse avant la recherche', async () => {
    const { tool: t, findByEmail } = tool({ byEmail: employeeRow });

    await t.execute!({ email: '  AWA@KissoHQ.com ' } as never, {} as never);

    expect(findByEmail).toHaveBeenCalledWith('awa@kissohq.com');
  });

  it('INSTRUIT au lieu de lever quand aucun des deux champs n’est fourni', async () => {
    const { tool: t, findById, findByEmail } = tool();

    const result = (await t.execute!({} as never, {} as never)) as {
      found: boolean;
      reason: string;
      hint: string;
    };

    // Une exception serait réinjectée au modèle en part `tool-error`, et un modèle privé de
    // résultat COMBLE le vide — c'est ainsi qu'est né l'over-promise « je crée le profil ? ».
    expect(result.found).toBe(false);
    expect(result.reason).toBe('missing_identifier');
    expect(result.hint).toMatch(/email|identifiant/i);
    expect(findById).not.toHaveBeenCalled();
    expect(findByEmail).not.toHaveBeenCalled();
  });

  it('dit honnêtement « inconnu » à un demandeur AUTORISÉ', async () => {
    const { tool: t } = tool({ byEmail: null });

    const result = (await t.execute!({ email: 'fantome@kissohq.com' } as never, {} as never)) as {
      found: boolean;
      reason: string;
    };

    expect(result.found).toBe(false);
    expect(result.reason).toBe('employee_not_found');
  });

  /**
   * ⚠️ LA PROPRIÉTÉ ANTI-ORACLE.
   *
   * Sur le chemin `employeeId`, le refus tombe AVANT la lecture : il ne peut donc rien
   * apprendre. Le chemin `email` doit forcément lire pour résoudre — le risque est alors de
   * transformer le tool en oracle d'existence : « not_authorized » signifierait « cette
   * adresse existe » et « employee_not_found » signifierait « elle n'existe pas ». Un
   * demandeur non autorisé énumérerait ainsi l'annuaire une adresse à la fois.
   *
   * Les deux cas doivent donc rendre EXACTEMENT le même verdict.
   */
  it('ne devient PAS un oracle : même verdict que l’adresse existe ou non', async () => {
    const existe = (await tool({ byEmail: employeeRow }).tool.execute!(
      { email: 'awa@kissohq.com' } as never,
      restricted as never,
    )) as { found: boolean; reason: string };

    const inconnue = (await tool({ byEmail: null }).tool.execute!(
      { email: 'personne@kissohq.com' } as never,
      restricted as never,
    )) as { found: boolean; reason: string };

    expect(existe.reason).toBe('not_authorized');
    expect(inconnue).toEqual(existe);
  });

  it('laisse chacun consulter SON PROPRE dossier par email', async () => {
    // La comparaison se fait sur `employees.id`, pas sur l'adresse : quelqu'un rétrogradé en
    // `readonly` garde le droit de lire son propre parcours.
    const mine = { ...employeeRow, id: ME, email: 'karylsoumaila1@gmail.com' };

    const result = (await tool({ byEmail: mine }).tool.execute!(
      { email: 'karylsoumaila1@gmail.com' } as never,
      restricted as never,
    )) as { found: boolean };

    expect(result.found).toBe(true);
  });

  it('le chemin employeeId refuse TOUJOURS avant la moindre lecture', async () => {
    // Non-régression de la propriété d'origine : elle ne doit pas être perdue en chemin.
    const { tool: t, findById, findByEmail } = tool({ byId: employeeRow });

    const result = (await t.execute!(
      { employeeId: SOMEONE_ELSE } as never,
      restricted as never,
    )) as { found: boolean; reason: string };

    expect(result.reason).toBe('not_authorized');
    expect(findById).not.toHaveBeenCalled();
    expect(findByEmail).not.toHaveBeenCalled();
  });
});
