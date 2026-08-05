import { describe, it, expect } from 'vitest';
import { employeeDtoSchema } from '../../../src/features/employee/application/dtos/employee.dto';
import { EmployeeStatus } from '../../../src/shared/types';
import { randomUUID } from 'crypto';

describe('DTO: Employee', () => {
  const baseValidDto = {
    id: randomUUID(),
    firstName: 'Alice',
    lastName: 'Smith',
    email: 'alice.smith@kisso.com',
    department: 'Engineering',
    position: 'Senior Developer',
    startDate: new Date().toISOString(),
    status: EmployeeStatus.Pending,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  it('should successfully validate a complete, valid DTO', () => {
    const result = employeeDtoSchema.safeParse(baseValidDto);
    expect(result.success).toBe(true);
  });

  describe('Validation Failures', () => {
    const invalidCases = [
      { field: 'id', value: 'not-a-uuid', reason: 'invalid UUID' },
      { field: 'firstName', value: '', reason: 'empty string' },
      { field: 'lastName', value: 'a'.repeat(101), reason: 'too long' },
      { field: 'email', value: 'invalid-email', reason: 'invalid email format' },
      { field: 'startDate', value: '2026-08-01', reason: 'not a full ISO datetime string' }, // missing T00:00:00.000Z
      { field: 'status', value: 'UNKNOWN_STATUS', reason: 'invalid enum value' }
    ];

    it.each(invalidCases)('should fail validation when $field is $reason', ({ field, value }) => {
      const invalidDto = { ...baseValidDto, [field]: value };
      const result = employeeDtoSchema.safeParse(invalidDto);
      
      expect(result.success).toBe(false);
      if (!result.success) {
        // Assert that the error is indeed related to the field we tampered with
        const errorPath = result.error.errors[0].path[0];
        expect(errorPath).toBe(field);
      }
    });
  });
});
