import { describe, it, expect, vi } from 'vitest';

import { makeGetEmployeeProfile } from '../../../src/features/employee/application/tools/get-employee-profile';
import { CALLER_EMPLOYEE_ID, slackCaller } from '../../helpers/slack-caller';

const row = {
  id: CALLER_EMPLOYEE_ID,
  firstName: 'Karyl',
  lastName: 'SOUMAILA',
  email: 'karyl@example.com',
  position: 'Developer',
};

function build() {
  const findById = vi.fn().mockResolvedValue(row);
  const tool = makeGetEmployeeProfile(
    { findById, findByEmail: vi.fn() } as never,
    { findByEmployee: vi.fn().mockResolvedValue(null) } as never,
  );
  return { tool, findById };
}

describe('getEmployeeProfile — sans identifiant, le dossier du demandeur', () => {
  it('lit le dossier du demandeur relié', async () => {
    const { tool, findById } = build();
    const result = (await tool.execute!({} as never, slackCaller())) as { found: boolean };
    expect(result.found).toBe(true);
    expect(findById).toHaveBeenCalledWith(CALLER_EMPLOYEE_ID);
  });

  it('demande toujours QUI quand le demandeur n’a aucun dossier relié', async () => {
    const { tool, findById } = build();
    const caller = slackCaller({ employeeId: '' });
    const result = (await tool.execute!({} as never, caller)) as { reason: string };
    expect(result.reason).toBe('missing_identifier');
    expect(findById).not.toHaveBeenCalled();
  });
});
