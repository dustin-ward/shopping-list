import { describe, expect, it } from 'vitest';
import {
  canonicalUnit,
  readQuantity,
} from '../../src/lib/server/receipts/quantity';

describe('readQuantity', () => {
  it('reads the count-with-unit-price form (`2 @ 1.50`, `2 x 1.50`)', () => {
    expect(readQuantity('CUCUMBERS 2 @ 1.50')).toEqual({
      real: 2,
      text: '2 @ 1.50',
      unit: 'ea',
      unitPriceMinor: 150,
      totalPriceMinor: null,
      name: 'CUCUMBERS',
    });
    expect(readQuantity('SODA 2 X 0.75')).toEqual({
      real: 2,
      text: '2 X 0.75',
      unit: 'ea',
      unitPriceMinor: 75,
      totalPriceMinor: null,
      name: 'SODA',
    });
  });

  it('reads the weighted form with its per-unit price (`1.350 LB @ 5.99/LB`)', () => {
    expect(readQuantity('CHICKEN BREAST 2.50LB @ 4.99/LB')).toEqual({
      real: 2.5,
      text: '2.50LB @ 4.99/LB',
      unit: 'lb',
      unitPriceMinor: 499,
      totalPriceMinor: null,
      name: 'CHICKEN BREAST',
    });
    expect(readQuantity('BANANAS 2.15 LB @ $0.59/LB')?.unit).toBe('lb');
    expect(readQuantity('CHEESE 0.75 KG @ 12.00/KG')?.unit).toBe('kg');
    expect(readQuantity('OLIVES 1.5 KG')).toEqual({
      real: 1.5,
      text: '1.5 KG',
      unit: 'kg',
      unitPriceMinor: null,
      totalPriceMinor: null,
      name: 'OLIVES',
    });
  });

  it('reads the multi-buy form (`2 FOR 4.00`)', () => {
    expect(readQuantity('TORTILLAS 2 FOR 4.00')).toEqual({
      real: 2,
      text: '2 FOR 4.00',
      unit: 'ea',
      unitPriceMinor: null,
      totalPriceMinor: 400,
      name: 'TORTILLAS',
    });
    expect(readQuantity('YOGURT 3 FOR $5.00')?.totalPriceMinor).toBe(500);
  });

  it('reads the bare quantity form (`QTY 2`, `2 EA`)', () => {
    expect(readQuantity('QTY 2')).toEqual({
      real: 2,
      text: 'QTY 2',
      unit: 'ea',
      unitPriceMinor: null,
      totalPriceMinor: null,
      name: '',
    });
    expect(readQuantity('CANNED CORN QTY 4')?.name).toBe('CANNED CORN');
    expect(readQuantity('BAGELS 6 EA')?.unit).toBe('ea');
    expect(readQuantity('BAGELS 6 EACH')?.real).toBe(6);
  });

  it('keeps a unit it cannot canonically name, without inventing one', () => {
    expect(readQuantity('TEA 2 BOX @ 3.00')).toEqual({
      real: 2,
      text: '2 BOX @ 3.00',
      unit: null,
      unitPriceMinor: 300,
      totalPriceMinor: null,
      name: 'TEA',
    });
  });

  it('leaves sizes and plain names alone', () => {
    expect(readQuantity('MILK 2% 1L')).toBeNull();
    expect(readQuantity('SOURDOUGH BREAD')).toBeNull();
    // A package size is not a purchase quantity: an integer with a unit is as
    // likely a size as a count, so it stays verbatim.
    expect(readQuantity('GALA APPLES 3LB')).toBeNull();
    expect(readQuantity('PAPER TOWELS 6CT')).toBeNull();
    expect(readQuantity('CHEDDAR CHEESE 80Z')).toBeNull();
    expect(readQuantity('SPRINGFIELD IL 62704')).toBeNull();
    expect(readQuantity('')).toBeNull();
  });
});

describe('canonicalUnit', () => {
  it('maps printed unit words onto the canonical set', () => {
    expect(canonicalUnit('LB')).toBe('lb');
    expect(canonicalUnit('lbs')).toBe('lb');
    expect(canonicalUnit('KG')).toBe('kg');
    expect(canonicalUnit('OZ')).toBe('oz');
    expect(canonicalUnit('GR')).toBe('g');
    expect(canonicalUnit('LTR')).toBe('l');
    expect(canonicalUnit('ML')).toBe('ml');
    expect(canonicalUnit('EACH')).toBe('ea');
    expect(canonicalUnit('CT')).toBe('ea');
    expect(canonicalUnit('BOX')).toBeNull();
    expect(canonicalUnit('')).toBeNull();
  });
});
