import { describe, expect, it } from 'vitest';
import { BUILT_IN_REDACTION_PATTERNS } from '../src/redaction.js';

describe('built-in redaction patterns', () => {
  it('declares the four required patterns', () => {
    const names = BUILT_IN_REDACTION_PATTERNS.map((p) => p.name);
    expect(names).toEqual(['jwt', 'api_key_inline', 'pem_block', 'password_field']);
  });

  it('all patterns compile to a non-empty regex and replacement', () => {
    for (const p of BUILT_IN_REDACTION_PATTERNS) {
      expect(p.regex.length).toBeGreaterThan(0);
      expect(p.replacement.length).toBeGreaterThan(0);
      // sanity: regex literal parses
      new RegExp(p.regex);
    }
  });
});
