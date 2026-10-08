import { describe, expect, it } from 'vitest';
import { type CartLine, summarize } from './cart.service.js';

const line = (over: Partial<CartLine>): CartLine => ({
  variantId: 'v',
  productName: 'Vestido',
  productSlug: 'vestido',
  sku: 'V-M',
  size: 'M',
  color: 'Preto',
  imageUrl: null,
  unitPriceCents: 10000,
  compareAtPriceCents: null,
  quantity: 1,
  lineTotalCents: 10000,
  purchasable: true,
  available: 5,
  ...over,
});

describe('summarize', () => {
  it('is checkout ready when every line can be ordered', () => {
    const cart = summarize([line({ quantity: 2, lineTotalCents: 20000 }), line({ variantId: 'w' })]);
    expect(cart).toMatchObject({ itemCount: 3, subtotalCents: 30000, shippingCents: 0, checkoutReady: true });
    expect(cart.items[0]).not.toHaveProperty('purchasable');
  });

  it('flags lines that became unavailable or understocked', () => {
    const cart = summarize([
      line({ variantId: 'gone', purchasable: false }),
      line({ variantId: 'short', quantity: 4, available: 2 }),
      line({ variantId: 'oversold', quantity: 1, available: -1 }),
    ]);
    expect(cart.checkoutReady).toBe(false);
    expect(cart.items.map((i) => [i.variantId, i.issue, i.availableQuantity])).toEqual([
      ['gone', 'unavailable', undefined],
      ['short', 'insufficient_stock', 2],
      ['oversold', 'insufficient_stock', 0],
    ]);
  });

  it('is not checkout ready when empty', () => {
    expect(summarize([])).toMatchObject({ items: [], checkoutReady: false, totalCents: 0 });
  });
});
