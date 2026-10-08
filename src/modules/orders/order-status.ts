import { orderStatuses } from '../../db/schema/orders.js';

export { orderStatuses };
export type OrderStatus = (typeof orderStatuses)[number];

/** What a transition does to the order's reserved stock. */
export type StockEffect = 'none' | 'commit' | 'release';

/**
 * The order state machine: for each status, where it may go next and what
 * that does to stock. Statuses with no entries are final.
 */
const transitions: Record<OrderStatus, Partial<Record<OrderStatus, StockEffect>>> = {
  pending_payment: { paid: 'commit', cancelled: 'release', expired: 'release' },
  paid: { shipped: 'none' },
  shipped: { delivered: 'none' },
  delivered: {},
  cancelled: {},
  expired: {},
};

/** Statuses an admin may set by hand. Only payments mark orders paid; only expiry expires them. */
export const adminTargets: readonly OrderStatus[] = ['shipped', 'delivered', 'cancelled'];

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`an order cannot move from ${from} to ${to}`);
  }
}

export function stockEffect(from: OrderStatus, to: OrderStatus): StockEffect {
  const effect = transitions[from][to];
  if (!effect) throw new InvalidTransitionError(from, to);
  return effect;
}
