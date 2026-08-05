import { describe, it, expect } from 'vitest';
import { Email } from '../../../src/features/employee/domain/value-objects/email';
import { ValidationError } from '../../../src/shared/errors';

describe('Value Object: Email', () => {
  describe('Happy Paths (Valid emails)', () => {
    const validEmails = [
      'test@example.com',
      'john.doe@kisso.com',
      'a.b.c@sub.domain.org',
      'firstname-lastname@company.co.uk'
    ];

    it.each(validEmails)('should successfully create Email VO for %s', (emailStr) => {
      const email = Email.create(emailStr);
      expect(email).toBeInstanceOf(Email);
      expect(email.value).toBe(emailStr);
      expect(email.toString()).toBe(emailStr);
    });
  });

  describe('Edge Cases & Security (Invalid emails)', () => {
    const invalidEmails = [
      '',
      ' ',
      'test@',
      '@example.com',
      'test@.com',
      'test@example.',
      'test example@com',
      'test@ex ample.com',
      'test@example..com',
      'admin@kisso',
      '<script>alert(1)</script>@kisso.com',
      '../../etc/passwd@kisso.com'
    ];

    it.each(invalidEmails)('should throw ValidationError for %s', (emailStr) => {
      expect(() => Email.create(emailStr)).toThrow(ValidationError);
      expect(() => Email.create(emailStr)).toThrow(/Invalid email format/);
    });
  });
});
