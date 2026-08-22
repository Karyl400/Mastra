import { describe, it, expect } from 'vitest';
import { createEmployee } from '../../../src/features/employee/domain/entities/employee';
import { createProgress } from '../../../src/features/onboarding/domain/entities/onboarding-progress';
import { createNotification } from '../../../src/features/notification/domain/entities/notification';
import {
  EmployeeStatus,
  OnboardingStatus,
  NotificationStatus,
  NotificationChannel,
  RecipientType,
} from '../../../src/shared/types';

// ─────────────────────────────────────────────────────────────
// Employee entity
// ─────────────────────────────────────────────────────────────

describe('Domain: Employee entity', () => {
  const base = {
    id: 'emp-001',
    firstName: 'Alice',
    lastName: 'Martin',
    email: 'alice.martin@kisso.com',
    department: 'Engineering',
    position: 'Backend Developer',
    startDate: '2026-01-15',
  };

  it('defaults to Pending status', () => {
    expect(createEmployee(base).status).toBe(EmployeeStatus.Pending);
  });

  it('auto-generates ISO timestamps', () => {
    const emp = createEmployee(base);
    expect(() => new Date(emp.createdAt)).not.toThrow();
    expect(() => new Date(emp.updatedAt)).not.toThrow();
    expect(emp.createdAt).toBe(emp.updatedAt);
  });

  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(createEmployee(base))).toBe(true);
  });

  it('preserves all provided fields', () => {
    const emp = createEmployee({ ...base, managerId: 'mgr-007' });
    expect(emp.id).toBe('emp-001');
    expect(emp.email).toBe('alice.martin@kisso.com');
    expect(emp.managerId).toBe('mgr-007');
  });

  it('accepts null managerId', () => {
    const emp = createEmployee({ ...base, managerId: null });
    expect(emp.managerId).toBeNull();
  });

  it('accepts undefined managerId', () => {
    const emp = createEmployee(base);
    expect(emp.managerId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// OnboardingProgress entity
// ─────────────────────────────────────────────────────────────

describe('Domain: OnboardingProgress entity', () => {
  const base = {
    id: 'prog-001',
    employeeId: 'emp-001',
    currentStep: 0,
    totalSteps: 5,
  };

  it('defaults to NotStarted status', () => {
    expect(createProgress(base).status).toBe(OnboardingStatus.NotStarted);
  });

  it('sets createdAt and updatedAt', () => {
    const p = createProgress(base);
    expect(p.createdAt).toBeDefined();
    expect(p.updatedAt).toBeDefined();
  });

  it('preserves totalSteps', () => {
    expect(createProgress(base).totalSteps).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────
// Notification entity
// ─────────────────────────────────────────────────────────────

describe('Domain: Notification entity', () => {
  const base = {
    id: 'notif-001',
    recipientId: 'emp-001',
    recipientType: RecipientType.Employee,
    channel: NotificationChannel.Email,
    subject: 'Bienvenue',
    body: '<p>Bonjour !</p>',
  };

  it('defaults to Pending status', () => {
    expect(createNotification(base).status).toBe(NotificationStatus.Pending);
  });

  it('sets createdAt and updatedAt', () => {
    const n = createNotification(base);
    expect(n.createdAt).toBeDefined();
    expect(n.createdAt).toBe(n.updatedAt);
  });

  it('preserves channel', () => {
    expect(createNotification(base).channel).toBe(NotificationChannel.Email);
  });

  it('preserves subject and body', () => {
    const n = createNotification(base);
    expect(n.subject).toBe('Bienvenue');
    expect(n.body).toContain('Bonjour');
  });
});
