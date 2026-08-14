import { describe, it, expect, vi } from 'vitest';

import { makeGetEmployeeProfile } from '../../../src/features/employee/application/tools/get-employee-profile';

/**
 * Même défaut que `updateOnboardingStatus` : une exception levée par un tool
 * n'arrive pas au catch du handler Slack, elle est réinjectée au modèle comme
 * part `tool-error` — et un modèle privé de résultat COMBLE le vide. Ici il
 * proposait « as-tu besoin que je crée un profil ? », capacité qui n'existe pas
 * (la création passe uniquement par le formulaire « Compléter mon profil »).
 *
 * Second cas traité : le profil EXISTE mais son suivi d'intégration est absent
 * — l'état réel des deux employés de production, créés par le tool
 * `createEmployee` qui ne fait qu'un `repo.save()`. Le tool rendait alors une
 * coquille `progress: null` que le modèle interprétait comme « il faut le
 * créer ».
 */

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';

const employeeRow = {
  id: EMPLOYEE_ID,
  firstName: 'Karyl',
  lastName: 'SOUMAILA',
  email: 'karylsoumaila1@gmail.com',
  department: 'Engineering',
  position: 'Developer',
  startDate: '2026-09-01T00:00:00.000Z',
  status: 'pending',
  managerId: null,
};

function tool(employee: unknown, progress: unknown) {
  return makeGetEmployeeProfile(
    { findById: vi.fn().mockResolvedValue(employee) } as never,
    { findByEmployee: vi.fn().mockResolvedValue(progress) } as never,
  );
}

describe('getEmployeeProfile — employé inconnu', () => {
  it('ne lève JAMAIS et rend un échec structuré', async () => {
    const result = (await tool(null, null).execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as { found: boolean; reason: string; hint: string };

    expect(result.found).toBe(false);
    expect(result.reason).toBe('employee_not_found');
    // Le modèle doit être renvoyé vers le chemin qui, lui, existe.
    expect(result.hint).toMatch(/findEmployeeByEmail/);
  });

  it('marque explicitement le succès par found=true', async () => {
    const result = (await tool(employeeRow, null).execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as { found: boolean };

    expect(result.found).toBe(true);
  });
});

describe('getEmployeeProfile — suivi d intégration absent', () => {
  it('signale que le suivi n est pas initialisé sans laisser croire à une création possible', async () => {
    const result = (await tool(employeeRow, null).execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as { progress: unknown; onboardingHint?: string };

    expect(result.progress).toBeNull();
    expect(result.onboardingHint).toMatch(/aucun outil/i);
    expect(result.onboardingHint).toMatch(/ne propose pas/i);
  });

  it('ne paie ce texte que dans le cas dégradé', async () => {
    // Budget : le tool-result est réémis à chaque aller-retour. Quand le suivi
    // existe, pas un caractère de plus.
    const result = (await tool(employeeRow, {
      status: 'in_progress',
      currentStep: 1,
      totalSteps: 5,
    }).execute!({ employeeId: EMPLOYEE_ID } as never, {} as never)) as Record<string, unknown>;

    expect(result).not.toHaveProperty('onboardingHint');
  });
});
