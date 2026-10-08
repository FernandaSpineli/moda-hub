/** Flat shipping fee, waived from FREE_SHIPPING_FROM_CENTS. */
export const SHIPPING_FEE_CENTS = 1990;
export const FREE_SHIPPING_FROM_CENTS = 29_900;
/** Most units of one variant a cart (and so an order) can hold. */
export const MAX_QUANTITY_PER_VARIANT = 10;

export interface PricedLine {
  unitPriceCents: number;
  compareAtPriceCents: number | null;
  quantity: number;
}

export interface Totals {
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  /** What the sale prices save against the "was" prices. */
  savingsCents: number;
  /** How much more qualifies for free shipping; 0 once it does. */
  freeShippingRemainingCents: number;
}

export function priceLines(lines: PricedLine[]): Totals {
  let subtotalCents = 0;
  let savingsCents = 0;
  for (const l of lines) {
    subtotalCents += l.unitPriceCents * l.quantity;
    if (l.compareAtPriceCents) savingsCents += (l.compareAtPriceCents - l.unitPriceCents) * l.quantity;
  }
  const freeShipping = subtotalCents >= FREE_SHIPPING_FROM_CENTS;
  const shippingCents = lines.length === 0 || freeShipping ? 0 : SHIPPING_FEE_CENTS;
  return {
    subtotalCents,
    shippingCents,
    totalCents: subtotalCents + shippingCents,
    savingsCents,
    freeShippingRemainingCents: freeShipping ? 0 : FREE_SHIPPING_FROM_CENTS - subtotalCents,
  };
}
