import { describe, it, expect } from 'vitest';
import { createEmployee } from '../../../src/features/employee/domain/entities/employee';
import { createProgress, createStep as createOnboardingStep } from '../../../src/features/onboarding/domain/entities/onboarding-progress';
import { createQuestionnaire, createResponse } from '../../../src/features/questionnaire/domain/entities/questionnaire';
import { createNotification } from '../../../src/features/notification/domain/entities/notification';
import {
  EmployeeStatus,
  OnboardingStatus,
  TaskStatus,
  QuestionnaireStatus,
  ResponseStatus,
  NotificationStatus,
  NotificationChannel,
  RecipientType,
  isValidTaskTransition,
  isTaskFinalStatus,
  isTaskActiveStatus,
  TASK_STATUS_TRANSITIONS,
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

describe('Domain: OnboardingStep entity', () => {
  const base = {
    id: 'step-001',
    progressId: 'prog-001',
    taskId: 'task-001',
    stepOrder: 1,
  };

  it('defaults to Pending status', () => {
    expect(createOnboardingStep(base).status).toBe(TaskStatus.Pending);
  });

  it('preserves stepOrder', () => {
    expect(createOnboardingStep(base).stepOrder).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// Questionnaire entity
// ─────────────────────────────────────────────────────────────

describe('Domain: Questionnaire entity', () => {
  const base = {
    id: 'q-001',
    title: 'Questionnaire d\'intégration',
    description: 'Questions pour le nouvel arrivant',
    questions: [
      { id: 'q1', type: 'text', text: 'Comment vous appelez-vous ?', required: true },
      { id: 'q2', type: 'choice', text: 'Quel département ?', required: false, options: ['IT', 'RH', 'Finance'] },
    ],
  };

  it('defaults to Draft status', () => {
    expect(createQuestionnaire(base).status).toBe(QuestionnaireStatus.Draft);
  });

  it('preserves questions array', () => {
    const q = createQuestionnaire(base);
    expect(q.questions).toHaveLength(2);
    expect(q.questions[0].id).toBe('q1');
  });

  it('sets auto timestamps', () => {
    const q = createQuestionnaire(base);
    expect(new Date(q.createdAt).getTime()).toBeGreaterThan(0);
  });
});

describe('Domain: QuestionnaireResponse entity', () => {
  const base = {
    id: 'resp-001',
    questionnaireId: 'q-001',
    employeeId: 'emp-001',
    answers: { q1: 'Jean Dupont', q2: 'IT' },
    score: 80,
    submittedAt: new Date().toISOString(),
  };

  it('defaults to Pending status', () => {
    expect(createResponse(base).status).toBe(ResponseStatus.Pending);
  });

  it('preserves score', () => {
    expect(createResponse(base).score).toBe(80);
  });

  it('preserves answers map', () => {
    expect(createResponse(base).answers).toEqual({ q1: 'Jean Dupont', q2: 'IT' });
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

// ─────────────────────────────────────────────────────────────
// Task status transitions
// ─────────────────────────────────────────────────────────────

describe('Domain: Task status transitions', () => {
  it('Pending → InProgress is valid', () => {
    expect(isValidTaskTransition(TaskStatus.Pending, TaskStatus.InProgress)).toBe(true);
  });

  it('Pending → Completed is invalid', () => {
    expect(isValidTaskTransition(TaskStatus.Pending, TaskStatus.Completed)).toBe(false);
  });

  it('InProgress → Completed is valid', () => {
    expect(isValidTaskTransition(TaskStatus.InProgress, TaskStatus.Completed)).toBe(true);
  });

  it('Completed → Archived is valid', () => {
    expect(isValidTaskTransition(TaskStatus.Completed, TaskStatus.Archived)).toBe(true);
  });

  it('Archived has no valid outgoing transitions', () => {
    expect(TASK_STATUS_TRANSITIONS[TaskStatus.Archived]).toHaveLength(0);
  });

  it('isTaskFinalStatus returns true for Completed, Cancelled, Archived', () => {
    expect(isTaskFinalStatus(TaskStatus.Completed)).toBe(true);
    expect(isTaskFinalStatus(TaskStatus.Cancelled)).toBe(true);
    expect(isTaskFinalStatus(TaskStatus.Archived)).toBe(true);
  });

  it('isTaskFinalStatus returns false for InProgress', () => {
    expect(isTaskFinalStatus(TaskStatus.InProgress)).toBe(false);
  });

  it('isTaskActiveStatus returns true for Pending, InProgress, Blocked, InReview', () => {
    expect(isTaskActiveStatus(TaskStatus.Pending)).toBe(true);
    expect(isTaskActiveStatus(TaskStatus.InProgress)).toBe(true);
    expect(isTaskActiveStatus(TaskStatus.Blocked)).toBe(true);
    expect(isTaskActiveStatus(TaskStatus.InReview)).toBe(true);
  });

  it('isTaskActiveStatus returns false for Completed', () => {
    expect(isTaskActiveStatus(TaskStatus.Completed)).toBe(false);
  });

  it('InProgress → Blocked is valid', () => {
    expect(isValidTaskTransition(TaskStatus.InProgress, TaskStatus.Blocked)).toBe(true);
  });

  it('Blocked → InProgress is valid (unblocked)', () => {
    expect(isValidTaskTransition(TaskStatus.Blocked, TaskStatus.InProgress)).toBe(true);
  });

  it('InProgress → InReview is valid', () => {
    expect(isValidTaskTransition(TaskStatus.InProgress, TaskStatus.InReview)).toBe(true);
  });

  it('InReview → Completed is valid', () => {
    expect(isValidTaskTransition(TaskStatus.InReview, TaskStatus.Completed)).toBe(true);
  });

  it('InReview → InProgress is valid (sent back)', () => {
    expect(isValidTaskTransition(TaskStatus.InReview, TaskStatus.InProgress)).toBe(true);
  });
});
