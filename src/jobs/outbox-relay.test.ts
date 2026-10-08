import { describe, expect, it } from 'vitest';
import { routes } from './outbox-relay.js';

const jobs = (type: string, payload: Record<string, unknown> = {}) =>
  routes(type, payload).map((r) => `${r.queue}/${r.job}`);

describe('event routing', () => {
  it('fans each event out to its consumers', () => {
    expect(jobs('auth.password_reset_requested')).toEqual(['notifications/password-reset']);
    expect(jobs('order.placed', { expiresAt: '2026-10-08T12:00:00Z' })).toEqual([
      'notifications/order-confirmation',
      'order-expiry/expire',
    ]);
    expect(jobs('order.status_changed', { to: 'paid' })).toEqual([
      'notifications/payment-confirmed',
      'inventory-alerts/check-low-stock',
    ]);
    expect(jobs('order.status_changed', { to: 'shipped' })).toEqual(['notifications/order-shipped']);
    expect(jobs('order.status_changed', { to: 'expired' })).toEqual(['notifications/order-closed']);
    expect(jobs('order.status_changed', { to: 'delivered' })).toEqual([]);
    expect(jobs('something.else')).toEqual([]);
  });

  it('delays expiry until the reservation runs out', () => {
    const [, expiry] = routes('order.placed', { expiresAt: '2026-10-08T12:00:00Z' });
    expect(expiry?.delayUntil).toBe('2026-10-08T12:00:00Z');
  });
});
