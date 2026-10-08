import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, startTestApp, type TestApp } from './support/app.js';
import { type SeededCatalog, seedCatalog } from './support/catalog.js';
import { sendWebhook, session } from './support/webhooks.js';

let t: TestApp;
let c: SeededCatalog;
beforeAll(async () => {
  t = await startTestApp({ worker: true });
  c = await seedCatalog(t);
});
afterAll(() => t.close());

/** Sends a signed webhook and waits for the worker to apply it. */
async function deliver(event: Parameters<typeof sendWebhook>[1]) {
  await sendWebhook(t, event).expect(200);
  await t.idle();
}

const blusa = () => c.products.blusa.variantIds[0] as string;

/** A customer with a pending order for 2 x Blusa de Algodão PP (R$ 179,80 + R$ 19,90 shipping). */
async function pendingOrder() {
  await t.sql.query('UPDATE inventory SET on_hand = on_hand + 2 WHERE variant_id = $1', [blusa()]);
  const { token } = await signUp(t);
  const auth = { Authorization: `Bearer ${token}` };
  await t.http.post('/api/v1/cart/items').set(auth).send({ variantId: blusa(), quantity: 2 }).expect(200);
  const order = (await t.http.post('/api/v1/orders').set(auth).expect(201)).body;
  return { auth, order, checkout: () => t.http.post(`/api/v1/orders/${order.id}/checkout`).set(auth) };
}

const orderOf = async (auth: Record<string, string>, id: string) =>
  (await t.http.get(`/api/v1/orders/${id}`).set(auth)).body;
const paymentStatus = async (sessionId: string) =>
  (await t.sql.query('SELECT status FROM payments WHERE stripe_checkout_session_id = $1', [sessionId]))
    .rows[0]?.status;
const stock = async () =>
  (await t.sql.query('SELECT on_hand, reserved FROM inventory WHERE variant_id = $1', [blusa()])).rows[0];
const gateway = () => t.gateway as NonNullable<TestApp['gateway']>;

describe('checkout', () => {
  it('creates a Stripe session priced from the order, shipping included', async () => {
    const { order, checkout } = await pendingOrder();
    const co = (await checkout().expect(201)).body;
    expect(co).toMatchObject({
      sessionId: expect.stringMatching(/^cs_test_/),
      checkoutUrl: expect.any(String),
    });

    const req = gateway().requests.at(-1);
    expect(req).toMatchObject({
      orderId: order.id,
      currency: 'brl',
      shippingCents: 1990,
      lines: [{ name: 'Blusa de Algodão — PP / Branco', unitPriceCents: 8990, quantity: 2 }],
      idempotencyKey: `checkout-${order.id}-1`,
    });
    const ttl = (req?.expiresAt.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(30 * 60_000); // Stripe's minimum, with a margin
    expect(req?.successUrl).toBe(`http://shop.test/checkout/success?order_id=${order.id}`);
  });

  it('extends the reservation past the session', async () => {
    const { auth, order, checkout } = await pendingOrder();
    const co = (await checkout().expect(201)).body;
    expect(new Date((await orderOf(auth, order.id)).expiresAt).getTime()).toBeGreaterThan(
      new Date(co.expiresAt).getTime(),
    );
  });

  it('hands back the open session instead of creating another', async () => {
    const { checkout } = await pendingOrder();
    const before = gateway().requests.length;
    const first = (await checkout().expect(201)).body;
    const second = (await checkout().expect(200)).body;
    expect(second.sessionId).toBe(first.sessionId);
    expect(gateway().requests.length).toBe(before + 1);
  });

  it('gives concurrent requests the same session', async () => {
    const { order, checkout } = await pendingOrder();
    const results = await Promise.all(Array.from({ length: 6 }, () => checkout()));
    expect(new Set(results.map((r) => r.body.sessionId)).size).toBe(1);
    const { rows } = await t.sql.query('SELECT count(*)::int AS n FROM payments WHERE order_id = $1', [
      order.id,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('refuses other users, unknown orders and orders that are not pending', async () => {
    const { auth, order, checkout } = await pendingOrder();
    const other = await signUp(t);
    await t.http
      .post(`/api/v1/orders/${order.id}/checkout`)
      .set('Authorization', `Bearer ${other.token}`)
      .expect(404);
    await t.http.post('/api/v1/orders/nope/checkout').set(auth).expect(404);
    await t.http.post(`/api/v1/orders/${order.id}/cancel`).set(auth).expect(200);
    expect((await checkout().expect(409)).body.error.code).toBe('ORDER_NOT_PAYABLE');
  });

  it('reports Stripe outages without details and recovers', async () => {
    const { checkout } = await pendingOrder();
    gateway().failWith = 'stripe: connect ECONNREFUSED (request_id=req_123)';
    const res = await checkout().expect(502);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('req_123');
    expect(t.logs.some((l) => l.event === 'stripe.request_failed')).toBe(true);
    gateway().failWith = undefined;
    await checkout().expect(201);
  });

  it('answers 503 when payments are not configured', async () => {
    const off = await startTestApp({
      paymentGateway: null,
      env: { STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' },
    });
    try {
      const { token } = await signUp(off);
      await off.http
        .post('/api/v1/orders/01a11699-7a06-7d19-ace9-45b3da7b647b/checkout')
        .set('Authorization', `Bearer ${token}`)
        .expect(503);
      await off.http.post('/api/v1/payments/webhook').send({}).expect(503);
    } finally {
      await off.close();
    }
  });
});

describe('webhooks', () => {
  it('mark the order paid and turn the reservation into a sale', async () => {
    const { auth, order, checkout } = await pendingOrder();
    const co = (await checkout().expect(201)).body;
    const before = await stock();

    await deliver({
      id: 'evt_paid',
      type: 'checkout.session.completed',
      object: session(co.sessionId, order.totalCents, 'paid'),
    });

    const paid = await orderOf(auth, order.id);
    expect(paid).toMatchObject({ status: 'paid', expiresAt: null });
    expect(paid.statusHistory.at(-1).reason).toBe('payment confirmed by Stripe');
    expect(await stock()).toEqual({ on_hand: before.on_hand - 2, reserved: before.reserved - 2 });
    expect(await paymentStatus(co.sessionId)).toBe('succeeded');
    const { rows } = await t.sql.query(
      `SELECT payload->>'to' AS "to" FROM outbox_events WHERE aggregate_id = $1 AND type = 'order.status_changed'`,
      [order.id],
    );
    expect(rows.map((r) => r.to)).toEqual(['paid']);
  });

  it('apply a redelivered event only once', async () => {
    const { auth, order, checkout } = await pendingOrder();
    const co = (await checkout().expect(201)).body;
    const event = {
      id: 'evt_dup',
      type: 'checkout.session.completed',
      object: session(co.sessionId, order.totalCents, 'paid'),
    };
    const before = await stock();

    const results = await Promise.all(Array.from({ length: 5 }, () => sendWebhook(t, event)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    await deliver(event);

    expect((await orderOf(auth, order.id)).statusHistory).toHaveLength(2);
    expect((await stock()).on_hand).toBe(before.on_hand - 2);
    expect(t.logs.some((l) => l.event === 'webhook.duplicate')).toBe(true);
  });

  it('are rejected when forged or replayed', async () => {
    const { auth, order, checkout } = await pendingOrder();
    const co = (await checkout().expect(201)).body;
    const event = {
      id: 'evt_forged',
      type: 'checkout.session.completed',
      object: session(co.sessionId, order.totalCents, 'paid'),
    };

    for (const res of [
      await sendWebhook(t, event, { secret: 'whsec_attacker' }),
      await sendWebhook(t, event, { timestamp: Math.floor(Date.now() / 1000) - 600 }),
      await t.http
        .post('/api/v1/payments/webhook')
        .set('Content-Type', 'application/json')
        .send({ id: 'evt_x' }),
    ]) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    }
    expect((await orderOf(auth, order.id)).status).toBe('pending_payment');
  });

  it('wait for delayed methods (boleto) to settle, then pay', async () => {
    const { auth, order, checkout } = await pendingOrder();
    const co = (await checkout().expect(201)).body;
    await deliver({
      id: 'evt_b1',
      type: 'checkout.session.completed',
      object: session(co.sessionId, order.totalCents, 'unpaid'),
    });
    expect((await orderOf(auth, order.id)).status).toBe('pending_payment');
    await deliver({
      id: 'evt_b2',
      type: 'checkout.session.async_payment_succeeded',
      object: session(co.sessionId, order.totalCents, 'paid'),
    });
    expect((await orderOf(auth, order.id)).status).toBe('paid');
  });

  it('cancel the order and release stock when a delayed payment fails', async () => {
    const { auth, order, checkout } = await pendingOrder();
    const co = (await checkout().expect(201)).body;
    const before = await stock();
    await deliver({
      id: 'evt_f1',
      type: 'checkout.session.async_payment_failed',
      object: session(co.sessionId, order.totalCents, 'unpaid'),
    });
    const failed = await orderOf(auth, order.id);
    expect(failed.status).toBe('cancelled');
    expect(failed.statusHistory.at(-1).reason).toBe('payment failed');
    expect((await stock()).reserved).toBe(before.reserved - 2);
    expect(await paymentStatus(co.sessionId)).toBe('failed');
  });

  it('leave the order open when a session expires, so the customer can retry', async () => {
    const { auth, order, checkout } = await pendingOrder();
    const first = (await checkout().expect(201)).body;
    await deliver({
      id: 'evt_e1',
      type: 'checkout.session.expired',
      object: session(first.sessionId, order.totalCents, 'unpaid'),
    });
    expect(await paymentStatus(first.sessionId)).toBe('expired');
    expect((await orderOf(auth, order.id)).status).toBe('pending_payment');

    const second = (await checkout().expect(201)).body;
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(gateway().requests.at(-1)?.idempotencyKey).toBe(`checkout-${order.id}-2`);
  });

  it('never fulfil an order for the wrong amount', async () => {
    const { auth, order, checkout } = await pendingOrder();
    const co = (await checkout().expect(201)).body;
    await deliver({
      id: 'evt_amt',
      type: 'checkout.session.completed',
      object: session(co.sessionId, 100, 'paid'),
    });
    expect((await orderOf(auth, order.id)).status).toBe('pending_payment');
    expect(await paymentStatus(co.sessionId)).toBe('failed');
    expect(t.logs.some((l) => l.event === 'payment.amount_mismatch')).toBe(true);
  });

  it('flag a payment for an order that already closed for manual refund', async () => {
    const { auth, order, checkout } = await pendingOrder();
    const co = (await checkout().expect(201)).body;
    await t.sql.query(`UPDATE inventory SET reserved = reserved - 2 WHERE variant_id = $1`, [blusa()]);
    await t.sql.query(`UPDATE orders SET status = 'expired', expires_at = NULL WHERE id = $1`, [order.id]);

    await deliver({
      id: 'evt_late',
      type: 'checkout.session.completed',
      object: session(co.sessionId, order.totalCents, 'paid'),
    });
    expect((await orderOf(auth, order.id)).status).toBe('expired');
    expect(t.logs.some((l) => l.event === 'payment.requires_refund')).toBe(true);
  });

  it('block cancelling while a checkout is open', async () => {
    const { auth, order, checkout } = await pendingOrder();
    const co = (await checkout().expect(201)).body;
    expect(
      (await t.http.post(`/api/v1/orders/${order.id}/cancel`).set(auth).expect(409)).body.error.code,
    ).toBe('PAYMENT_IN_PROGRESS');
    await deliver({
      id: 'evt_c1',
      type: 'checkout.session.expired',
      object: session(co.sessionId, order.totalCents, 'unpaid'),
    });
    await t.http.post(`/api/v1/orders/${order.id}/cancel`).set(auth).expect(200);
  });

  it('acknowledge events that are not ours', async () => {
    await deliver({
      id: 'evt_other',
      type: 'customer.created',
      object: { id: 'cus_1', object: 'customer' },
    });
    await deliver({
      id: 'evt_unknown',
      type: 'checkout.session.completed',
      object: session('cs_not_ours', 100, 'paid'),
    });
    expect(t.logs.some((l) => l.event === 'webhook.unknown_session')).toBe(true);
  });
});
