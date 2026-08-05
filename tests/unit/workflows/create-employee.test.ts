import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CreateEmployeeUseCase,
  EmployeeDataSanitizer,
} from '../../../src/features/employee/application/tools/create-employee';
import { EmployeeStatus } from '../../../src/shared/types';
import { ConflictError, ValidationError } from '../../../src/shared/errors';

// Mock repository
const mockRepo = {
  save: vi.fn(),
  findById: vi.fn(),
  findByEmail: vi.fn(),
  findByNames: vi.fn(),
};

describe('Workflows & State Machines: createEmployee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('EmployeeDataSanitizer', () => {
    it('146. should sanitize HTML tags from department and position', () => {
      const dirtyInput = {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@kisso.com',
        department: '<script>alert("hack")</script>Engineering',
        position: 'Backend Developer <img src="x" onerror="alert(1)">',
        startDate: '2026-08-01',
        managerId: null,
        options: { initialStatus: EmployeeStatus.Pending },
      };

      const sanitized = EmployeeDataSanitizer.sanitize(dirtyInput as any);
      expect(sanitized.department).toBe('Engineering');
      expect(sanitized.position).toBe('Backend Developer ');
    });
  });

  describe('CreateEmployeeUseCase', () => {
    it('147. should throw a ConflictError if email already exists', async () => {
      mockRepo.findByEmail.mockResolvedValueOnce({ id: 'emp-existing' });
      const useCase = new CreateEmployeeUseCase(mockRepo as any);

      const input = {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@kisso.com',
        department: 'Engineering',
        position: 'Backend Developer',
        startDate: '2026-08-01',
      };

      await expect(useCase.execute(input)).rejects.toThrow(ConflictError);
    });

    it('148. should reject an invalid idempotency key (UUID validation)', async () => {
      const useCase = new CreateEmployeeUseCase(mockRepo as any);
      const input = {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@kisso.com',
        department: 'Engineering',
        position: 'Backend Developer',
        startDate: '2026-08-01',
        idempotencyKey: 'invalid-uuid-format-should-fail',
      };

      await expect(useCase.execute(input)).rejects.toBeInstanceOf(ValidationError);
      expect(mockRepo.save).not.toHaveBeenCalled();
    });
  });
});
