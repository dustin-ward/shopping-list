import { describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/lib/client/money';

describe('formatMoney', () => {
  it('formats minor units as the receipt currency, not as a bare number', () => {
    expect(formatMoney(349, 'USD')).toMatch(/3\.49/u);
    expect(formatMoney(349, 'USD')).not.toBe('3.49');
    expect(formatMoney(-150, 'USD')).toMatch(/1\.50/u);
  });

  it('falls back to the default currency when the receipt has none', () => {
    expect(formatMoney(349, null)).toBe(formatMoney(349, 'USD'));
  });
});
