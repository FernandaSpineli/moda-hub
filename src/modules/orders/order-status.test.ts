import { describe, expect, it } from 'vitest';
import {
  adminTargets,
  InvalidTransitionError,
  type OrderStatus,
  orderStatuses,
  stockEffect,
} from './order-status.js';

describe('order state machine', () => {
  it.each<[OrderStatus, OrderStatus, string]>([
    ['pending_payment', 'paid', 'commit'],
    ['pending_payment', 'cancelled', 'release'],
    ['pending_payment', 'expired', 'release'],
    ['paid', 'shipped', 'none'],
    ['shipped', 'delivered', 'none'],
  ])('%s -> %s %s stock', (from, to, effect) => {
    expect(stockEffect(from, to)).toBe(effect);
  });

  it.each<[OrderStatus, OrderStatus]>([
    ['pending_payment', 'shipped'],
    ['paid', 'cancelled'],
    ['paid', 'paid'],
    ['delivered', 'shipped'],
    ['cancelled', 'pending_payment'],
    ['expired', 'paid'],
  ])('forbids %s -> %s', (from, to) => {
    expect(() => stockEffect(from, to)).toThrow(InvalidTransitionError);
  });

  it('never lets admins mark orders paid or expired', () => {
    expect(adminTargets).not.toContain('paid');
    expect(adminTargets).not.toContain('expired');
    expect(orderStatuses).toHaveLength(6);
  });
});
