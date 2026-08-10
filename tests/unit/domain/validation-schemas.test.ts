/**
 * Comportement de `departmentSchema` / `positionSchema` après aplatissement du JSON Schema.
 *
 * Le `.pipe(z.nativeEnum(...))` a été remplacé par `z.preprocess(trim, z.nativeEnum(...))`
 * suivi de `.transform(sanitizeText)`. Ce fichier prouve que la sémantique runtime
 * est identique : trim en amont, allowlist stricte, sanitization en aval.
 */
import { describe, it, expect } from 'vitest';
import { departmentSchema, positionSchema } from '../../../src/shared/validation';
import { Department, Position } from '../../../src/shared/types';

describe('departmentSchema', () => {
  it('accepts every Department enum value', () => {
    for (const value of Object.values(Department)) {
      expect(departmentSchema.parse(value)).toBe(value);
    }
  });

  it('trims surrounding whitespace before validating (preprocess still runs)', () => {
    expect(departmentSchema.parse('   Engineering \t\n')).toBe(Department.Engineering);
  });

  it('rejects values outside the allowlist', () => {
    for (const bad of ['Eng', '', 'engineering', 'Vibes']) {
      expect(departmentSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects HTML / XSS payloads instead of silently cleaning them', () => {
    for (const bad of [
      '<script>alert(1)</script>',
      '<script>Engineering</script>',
      'Engineering<img src=x onerror=alert(1)>',
    ]) {
      expect(departmentSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects non-string inputs', () => {
    expect(departmentSchema.safeParse(42).success).toBe(false);
    expect(departmentSchema.safeParse(null).success).toBe(false);
  });

  it('returns a sanitised string (transform still runs — output is HTML-free)', () => {
    const parsed = departmentSchema.parse(Department.CustomerSuccess);
    expect(typeof parsed).toBe('string');
    expect(parsed).not.toMatch(/[<>]/);
  });
});

describe('positionSchema', () => {
  it('accepts every Position enum value', () => {
    for (const value of Object.values(Position)) {
      expect(positionSchema.parse(value)).toBe(value);
    }
  });

  it('trims surrounding whitespace before validating', () => {
    expect(positionSchema.parse('  Backend Developer  ')).toBe(Position.BackendDeveloper);
  });

  it('accepts job titles absent from the enum', () => {
    // Le poste est saisi librement par l'arrivant : ce n'est pas une taxonomie
    // RH. « Software Engineer », le titre le plus répandu du métier, ne figurait
    // pas dans l'enum de 24 valeurs.
    for (const title of [
      'Software Engineer',
      'Chief Vibes Officer',
      'Ingénieur R&D',
      'Développeur Full-Stack (L3)',
      'Product Manager - Growth',
    ]) {
      expect(positionSchema.safeParse(title).success, title).toBe(true);
    }
  });

  it('still rejects HTML payloads, empty values and one-character titles', () => {
    for (const bad of ['Backend Developer<img src=x>', '<script>alert(1)</script>', '', 'd']) {
      expect(positionSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('rejects a title longer than the column allows', () => {
    expect(positionSchema.safeParse('a'.repeat(151)).success).toBe(false);
  });
});
