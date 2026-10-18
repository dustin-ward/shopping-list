import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  moneyInputValue,
  parseMoneyInput,
} from '../../src/lib/client/money';

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

describe('parseMoneyInput', () => {
  it('reads the forms a reviewer types, into minor units', () => {
    expect(parseMoneyInput('3.49')).toBe(349);
    expect(parseMoneyInput('$3.49')).toBe(349);
    expect(parseMoneyInput(' 1,234.56 ')).toBe(123456);
    expect(parseMoneyInput('4')).toBe(400);
    expect(parseMoneyInput('4.5')).toBe(450);
    expect(parseMoneyInput('-1.50')).toBe(-150);
  });

  it('refuses amounts it cannot read exactly', () => {
    expect(parseMoneyInput('3.499')).toBeNull();
    expect(parseMoneyInput('1.2.3')).toBeNull();
    expect(parseMoneyInput('free')).toBeNull();
    expect(parseMoneyInput('1e3')).toBeNull();
    expect(parseMoneyInput('')).toBeNull();
  });

  it('refuses money signs and separators that are out of place', () => {
    expect(parseMoneyInput('1-2')).toBeNull();
    expect(parseMoneyInput('3$49')).toBeNull();
    expect(parseMoneyInput('1,2,3.45')).toBeNull();
    expect(parseMoneyInput('$')).toBeNull();
  });
});

describe('moneyInputValue', () => {
  it('round-trips every amount parseMoneyInput accepts', () => {
    for (const minor of [349, -150, 0, 123456]) {
      expect(parseMoneyInput(moneyInputValue(minor))).toBe(minor);
    }
  });

  it('shows an empty field for an amount the receipt does not carry', () => {
    expect(moneyInputValue(null)).toBe('');
  });
});
