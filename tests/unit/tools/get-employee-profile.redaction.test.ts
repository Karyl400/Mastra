import { describe, it, expect, vi } from 'vitest';
import { makeGetEmployeeProfile } from '../../../src/features/employee/application/tools/get-employee-profile';

/**
 * Garde-fou de non-régression sur la fuite de données personnelles.
 *
 * `getEmployeeProfile` est câblé aux TROIS agents et donc atteignable depuis
 * Slack par n'importe quel membre du workspace. Le repository fait un
 * `SELECT *` puis un `as Employee` : l'assertion de type disparaît à la
 * compilation et ne retire rien à l'exécution. Sans projection explicite, le
 * salaire et le contact d'urgence partent dans le contexte du LLM.
 */

/** Ce que le repository rend RÉELLEMENT : toutes les colonnes de la table. */
const ligneComplete = {
  id: '11111111-1111-4111-8111-111111111111',
  firstName: 'Karyl',
  lastName: 'SOUMAILA',
  email: 'karylsoumaila1@gmail.com',
  department: 'Engineering',
  position: 'Software Engineer',
  startDate: '2026-09-01T00:00:00.000Z',
  status: 'pending',
  managerId: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  // Colonnes sensibles réellement présentes en base (schema.ts:29-41)
  phone: '+229 90 00 00 00',
  salaryAmount: 68000,
  salaryCurrency: 'EUR',
  emergencyContactName: 'A. SOUMAILA',
  emergencyContactPhone: '+229 91 11 11 11',
  emergencyContactRelationship: 'parent',
  metadata: { note: 'confidentiel' },
  deletedAt: null,
};

const CHAMPS_INTERDITS = [
  'phone',
  'salaryAmount',
  'salaryCurrency',
  'emergencyContactName',
  'emergencyContactPhone',
  'emergencyContactRelationship',
  'metadata',
  'deletedAt',
] as const;

function makeTool() {
  return makeGetEmployeeProfile(
    { findById: vi.fn().mockResolvedValue(ligneComplete) } as never,
    { findByEmployee: vi.fn().mockResolvedValue(null) } as never,
  );
}

describe('getEmployeeProfile — redaction des données sensibles', () => {
  it("n'expose aucune colonne sensible, même si le repository les rend toutes", async () => {
    const result = (await makeTool().execute!(
      { employeeId: ligneComplete.id } as never,
      {} as never,
    )) as { employee: Record<string, unknown> };

    for (const champ of CHAMPS_INTERDITS) {
      expect(result.employee, `${champ} ne doit jamais sortir du tool`).not.toHaveProperty(champ);
    }
  });

  it('ne laisse aucune valeur sensible dans la sérialisation complète', async () => {
    // C'est la forme qui compte : c'est `JSON.stringify` du résultat qui entre
    // dans le contexte du LLM, pas l'objet typé.
    const result = await makeTool().execute!(
      { employeeId: ligneComplete.id } as never,
      {} as never,
    );
    const serialise = JSON.stringify(result);

    for (const valeur of ['68000', '+229 90 00 00 00', '+229 91 11 11 11', 'confidentiel']) {
      expect(serialise, `la valeur ${valeur} fuite`).not.toContain(valeur);
    }
  });

  it('expose bien les champs légitimes du parcours d’onboarding', async () => {
    const result = (await makeTool().execute!(
      { employeeId: ligneComplete.id } as never,
      {} as never,
    )) as { employee: Record<string, unknown> };

    expect(result.employee).toEqual({
      id: ligneComplete.id,
      firstName: 'Karyl',
      lastName: 'SOUMAILA',
      email: 'karylsoumaila1@gmail.com',
      department: 'Engineering',
      position: 'Software Engineer',
      startDate: '2026-09-01T00:00:00.000Z',
      status: 'pending',
      managerId: null,
    });
  });
});
