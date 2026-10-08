import Stripe from 'stripe';
import type { TestApp } from './app.js';
import { TEST_WEBHOOK_SECRET } from './config.js';

const stripe = new Stripe('sk_test_fake');

export function session(id: string, amount: number, paymentStatus: 'paid' | 'unpaid') {
  return {
    id,
    object: 'checkout.session',
    amount_total: amount,
    currency: 'brl',
    payment_status: paymentStatus,
    // Every session has its own PaymentIntent (the column is unique).
    payment_intent: `pi_for_${id}`,
  };
}

/** Sends a Stripe event signed like Stripe signs it (with `secret`, at `timestamp`). */
export function sendWebhook(
  t: TestApp,
  event: { id: string; type: string; object: object },
  { secret = TEST_WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {},
) {
  const payload = JSON.stringify({
    id: event.id,
    object: 'event',
    type: event.type,
    api_version: '2026-08-26.dahlia',
    created: timestamp,
    data: { object: event.object },
  });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
  return t.http
    .post('/api/v1/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', signature)
    .send(payload);
}
