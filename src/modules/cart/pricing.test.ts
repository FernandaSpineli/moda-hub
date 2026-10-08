import { describe, expect, it } from 'vitest';
import { FREE_SHIPPING_FROM_CENTS, priceLines, SHIPPING_FEE_CENTS } from './pricing.js';

describe('priceLines', () => {
  it('charges shipping below the free-shipping threshold', () => {
    expect(priceLines([{ unitPriceCents: 25990, compareAtPriceCents: null, quantity: 1 }])).toEqual({
      subtotalCents: 25990,
      shippingCents: SHIPPING_FEE_CENTS,
      totalCents: 25990 + SHIPPING_FEE_CENTS,
      savingsCents: 0,
      freeShippingRemainingCents: FREE_SHIPPING_FROM_CENTS - 25990,
    });
  });

  it('waives shipping from the threshold, inclusive', () => {
    const t = priceLines([{ unitPriceCents: 14950, compareAtPriceCents: null, quantity: 2 }]);
    expect(t).toMatchObject({
      subtotalCents: 29900,
      shippingCents: 0,
      totalCents: 29900,
      freeShippingRemainingCents: 0,
    });
  });

  it('adds up savings from sale prices', () => {
    const t = priceLines([
      { unitPriceCents: 25990, compareAtPriceCents: 32990, quantity: 2 },
      { unitPriceCents: 8990, compareAtPriceCents: null, quantity: 1 },
    ]);
    expect(t.savingsCents).toBe(2 * 7000);
    expect(t.subtotalCents).toBe(2 * 25990 + 8990);
  });

  it('charges nothing for an empty cart', () => {
    expect(priceLines([])).toMatchObject({ subtotalCents: 0, shippingCents: 0, totalCents: 0 });
  });
});
