/* eslint-disable security/detect-unsafe-regex, security/detect-non-literal-regexp */

import { randomBytes } from 'crypto';

import type { DelimiterSet } from './guardrail-types';

export class DelimiterGenerator {
  private static readonly PREFIX_LENGTH = 16;

  static generate(): DelimiterSet {
    const prefix = randomBytes(this.PREFIX_LENGTH).toString('hex');
    const suffix = randomBytes(this.PREFIX_LENGTH).toString('hex');
    const tagPrefix = `kisso_${prefix}`;

    return { prefix, suffix, tagPrefix };
  }

  static validateDelimiterIntegrity(
    text: string,
    delimiters: DelimiterSet,
  ): { valid: boolean; reason?: string } {
    const escapedTag = delimiters.tagPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const openUserTag = new RegExp(`<\\s*${escapedTag}_user_input\\b[^>]*>`, 'g');
    const closeUserTag = new RegExp(`<\\s*\\/\\s*${escapedTag}_user_input\\b[^>]*>`, 'g');

    const openUserCount = (text.match(openUserTag) || []).length;
    const closeUserCount = (text.match(closeUserTag) || []).length;

    if (openUserCount > 1 || closeUserCount > 1) {
      return { valid: false, reason: 'Multiple user input tags detected' };
    }

    const openExtTag = new RegExp(`<\\s*${escapedTag}_external_data\\b[^>]*>`, 'g');
    const closeExtTag = new RegExp(`<\\s*\\/\\s*${escapedTag}_external_data\\b[^>]*>`, 'g');

    const openExtCount = (text.match(openExtTag) || []).length;
    const closeExtCount = (text.match(closeExtTag) || []).length;

    if (openExtCount > 1 || closeExtCount > 1) {
      return { valid: false, reason: 'Multiple external data tags detected' };
    }

    const suspiciousTagPattern =
      /<\s*(?:\/\s*)?(?:user_input|external_data|system|instruction|prompt|security)[^<>]*>/gi;
    if (suspiciousTagPattern.test(text)) {
      return { valid: false, reason: 'Suspicious tag injection detected' };
    }

    return { valid: true };
  }
}

export function sanitizeInputAdvanced(input: string, delimiters: DelimiterSet): string {
  const { tagPrefix } = delimiters;

  let sanitized = input.normalize('NFKC');

  const unicodeTagPattern =
    /<[⁄∕ⅼ<>]{0,16}[⁣\u0455\u03F2\u0435\u0440]{0,16}(?:user_input|external_data|system|instruction)[^>]*>/gi;
  sanitized = sanitized.replace(unicodeTagPattern, (match) => {
    return match.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });

  sanitized = sanitized.replace(/<\/?\s*[a-zA-Z_][^<>]*>/g, (match) => {
    if (match.includes(tagPrefix)) {
      return match;
    }
    return match.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });

  const closeUserTag = new RegExp(`<\\s*\\/\\s*${tagPrefix}_user_input\\b[^>]*>`, 'gi');
  const closeExtTag = new RegExp(`<\\s*\\/\\s*${tagPrefix}_external_data\\b[^>]*>`, 'gi');

  sanitized = sanitized.replace(closeUserTag, '[/USER_INPUT_TAG_REMOVED]');
  sanitized = sanitized.replace(closeExtTag, '[/EXTERNAL_DATA_TAG_REMOVED]');

  sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, '');

  return sanitized;
}
