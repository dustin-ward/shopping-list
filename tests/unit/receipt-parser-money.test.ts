import { describe, expect, it } from 'vitest';
import {
  formatMinor,
  isMoneyToken,
  parseMoneyMinor,
} from '../../src/lib/server/receipts/money';

describe('parseMoneyMinor', () => {
  it('reads the printed forms a receipt uses into integer minor units', () => {
    expect(parseMoneyMinor('3.49')).toBe(349);
    expect(parseMoneyMinor('0.00')).toBe(0);
    expect(parseMoneyMinor('41.96')).toBe(4196);
    expect(parseMoneyMinor('1,234.56')).toBe(123456);
    // A four-figure total without separators is still an amount.
    expect(parseMoneyMinor('1234.56')).toBe(123456);
    expect(parseMoneyMinor('$3.49')).toBe(349);
    expect(parseMoneyMinor('-1.50')).toBe(-150);
    expect(parseMoneyMinor('-$1.50')).toBe(-150);
    // A trailing minus is how thermal printers render refunds and coupons.
    expect(parseMoneyMinor('1.00-')).toBe(-100);
    expect(parseMoneyMinor(' 2.47 ')).toBe(247);
  });

  it('rejects anything that is not unambiguously an amount', () => {
    // Three decimal-like groups: a money trap, never guessed at.
    expect(parseMoneyMinor('1.234.56')).toBeNull();
    expect(parseMoneyMinor('1.234.567')).toBeNull();
    expect(parseMoneyMinor('12.345.67')).toBeNull();
    // Three decimals: 3 whole units or 3499 minor units? Not our call.
    expect(parseMoneyMinor('3.499')).toBeNull();
    expect(parseMoneyMinor('1.2')).toBeNull();
    expect(parseMoneyMinor('1')).toBeNull();
    expect(parseMoneyMinor('1,23.45')).toBeNull();
    expect(parseMoneyMinor('12,34,567.89')).toBeNull();
    expect(parseMoneyMinor('8.00%')).toBeNull();
    expect(parseMoneyMinor('4.99/LB')).toBeNull();
    expect(parseMoneyMinor('2.15LB')).toBeNull();
    expect(parseMoneyMinor('')).toBeNull();
    expect(parseMoneyMinor('$')).toBeNull();
    expect(parseMoneyMinor('TOTAL')).toBeNull();
  });

  it('refuses to read a trap as money when called on a whole line', () => {
    expect(isMoneyToken('3.49')).toBe(true);
    expect(isMoneyToken('1.234.56')).toBe(false);
    expect(isMoneyToken('TAX 6.25%')).toBe(false);
  });
});

describe('formatMinor', () => {
  it('renders minor units back as the printed amount', () => {
    expect(formatMinor(349)).toBe('3.49');
    expect(formatMinor(-150)).toBe('-1.50');
    expect(formatMinor(123456)).toBe('1234.56');
    expect(formatMinor(0)).toBe('0.00');
  });
});
