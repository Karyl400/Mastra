/* eslint-disable sonarjs/regex-complexity, security/detect-unsafe-regex, no-control-regex */

export function defendAgainstSplitInjection(text: string): string {
  const splitPatterns = [
    /(?:to\s+be\s+continued|continues?\s+below|part\s+\d+\s+of|continued\s+from)/i,
    /(?:assemble|combine|join|concatenate)\s+(?:these|the\s+following|all)\s+(?:parts?|messages?|pieces?)/i,
    /(?:the\s+)?(?:real|actual|true)\s+(?:instruction|command|prompt)\s+(?:is|will\s+be|follows?|comes?\s+(?:next|later|after))/i,
  ];

  for (const pattern of splitPatterns) {
    if (pattern.test(text)) {
      return `[NOTICE: Multi-part message detected - each part is evaluated independently]\n${text}`;
    }
  }

  return text;
}

export function neutralizeEscapeSequences(text: string): string {
  return text
    .replace(/\0/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\u200B-\u200F\u2060\uFEFF]/gu, '');
}

export function scanUnicodeThreats(text: string): { hasThreats: boolean; threats: string[] } {
  const threats: string[] = [];

  if (/[\u200B-\u200F\uFEFF]/.test(text)) {
    threats.push('Zero-width characters detected');
  }

  const cyrillicCount = (text.match(/[а-яА-Я\u0455\u03F2]/g) || []).length;
  const totalChars = Math.max(text.length, 1);

  if (cyrillicCount > 0 && cyrillicCount / totalChars > 0.2) {
    const russianWords = /[а-яА-Я]{3,}/g;
    const russianWordCount = (text.match(russianWords) || []).length;

    if (russianWordCount < 2) {
      threats.push('Suspicious homoglyph usage (isolated Cyrillic characters)');
    }
  }

  if (/[\u{E0000}-\u{E007F}]/u.test(text)) {
    threats.push('Unicode tag characters detected (hidden text)');
  }

  return { hasThreats: threats.length > 0, threats };
}

export function neutralizeHiddenInstructions(text: string): string {
  let neutralized = text;

  const hiddenPatterns = [
    /(?:color\s*:\s*(?:white|transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))|font-size\s*:\s*0)/gi,
    /(?:<!--\s*(?:ignore|system|instruction|prompt|security).*?-->)/gi,
    /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)/gi,
    /(?:position\s*:\s*absolute[\s;]*(?:left|top)\s*:\s*-9999px)/gi,
  ];

  for (const pattern of hiddenPatterns) {
    neutralized = neutralized.replace(pattern, '[HIDDEN_CONTENT_REMOVED]');
  }

  neutralized = neutralized.replace(
    /(?:system\s*(?:prompt|instruction|message|directive)|ignore\s+(?:previous|above|all))\s*(?::|is|are|was|were|should|must|will)/gi,
    '[POTENTIAL_INJECTION_REMOVED]',
  );

  return neutralized;
}
