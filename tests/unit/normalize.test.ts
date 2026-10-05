import { describe, expect, it } from 'vitest';
import { normalizeName } from '../../src/lib/shared/normalize';

describe('normalizeName', () => {
  it('normalizes compatibility characters, whitespace, and casing', () => {
    expect(normalizeName('  ＦＲＥＳＨ\tEggs  ')).toBe('fresh eggs');
  });

  it('does not infer that singular and plural names are identical', () => {
    expect(normalizeName('egg')).not.toBe(normalizeName('eggs'));
  });
});
