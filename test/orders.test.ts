import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, startTestApp, type TestApp } from './support/app.js';
import { type SeededCatalog, seedCatalog } from './support/catalog.js';

let t: TestApp;
let c: SeededCatalog;
beforeAll(async () => {
  t = await startTestApp();
  c = await seedCatalog(t);
});
afterAll(() => t.close());

const variant = (product: keyof SeededCatalog['products'], i = 0) =>
  c.products[product].variantIds[i] as string;

async function shopperWith(items: [string, number][]) {
  const { token, userId } = await signUp(t);
  const auth = { Authorization: `Bearer ${token}` };
  for (const [variantId, quantity] of items) {
    await t.http.post('/api/v1/cart/items').set(auth).send({ variantId, quantity }).expect(200);
  }
  return {
    auth,
    userId,
    place: (headers: Record<string, string> = {}) => t.http.post('/api/v1/orders').set(auth).set(headers),
  };
}

async function stock(variantId: string) {
  return (await t.http.get(`/api/v1/admin/variants/${variantId}/inventory`).set(c.auth).expect(200)).body;
}

async function setStock(variantId: string, onHand: number) {
  await t.sql.query('UPDATE inventory SET on_hand = $2, reserved = 0 WHERE variant_id = $1', [
    variantId,
    onHand,
  ]);
}

describe('placing an order', () => {
  it('reserves stock, snapshots the cart, records an event and empties the cart', async () => {
    await setStock(variant('blusa'), 10);
    const s = await shopperWith([
      [variant('blusa'), 2],
      [variant('vestidoLongo'), 1],
    ]);
    const res = await s.place({ 'X-Request-ID': 'order-trace-1' }).expect(201);
    const order = res.body;

    expect(res.headers.location).toBe(`/api/v1/orders/${order.id}`);
    expect(order).toMatchObject({
      status: 'pending_payment',
      currency: 'brl',
      subtotalCents: 2 * 8990 + 31990,
      shippingCents: 0,
      totalCents: 2 * 8990 + 31990,
    });
    expect(new Date(order.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(
      order.items.map((i: { sku: string; size: string; quantity: number }) => [i.sku, i.size, i.quantity]),
    ).toEqual([
      ['BA-PP-BR', 'PP', 2],
      ['VLF-G-EST', 'G', 1],
    ]);
    expect(order.statusHistory).toEqual([expect.objectContaining({ from: null, to: 'pending_payment' })]);

    expect(await stock(variant('blusa'))).toMatchObject({ onHand: 10, reserved: 2, available: 8 });
    expect((await t.http.get('/api/v1/cart').set(s.auth)).body.items).toEqual([]);

    const { rows } = await t.sql.query(
      'SELECT type, payload, correlation_id FROM outbox_events WHERE aggregate_id = $1',
      [order.id],
    );
    expect(rows).toEqual([
      {
        type: 'order.placed',
        payload: {
          orderId: order.id,
          userId: s.userId,
          totalCents: order.totalCents,
          expiresAt: order.expiresAt,
        },
        correlation_id: 'order-trace-1',
      },
    ]);
  });

  it('charges shipping below R$ 299', async () => {
    await setStock(variant('blusa'), 10);
    const s = await shopperWith([[variant('blusa'), 1]]);
    expect((await s.place().expect(201)).body).toMatchObject({
      subtotalCents: 8990,
      shippingCents: 1990,
      totalCents: 10980,
    });
  });

  it('keeps the price it was placed at', async () => {
    await setStock(variant('blusa'), 10);
    const s = await shopperWith([[variant('blusa'), 1]]);
    const order = (await s.place().expect(201)).body;
    await t.http
      .patch(`/api/v1/admin/variants/${variant('blusa')}`)
      .set(c.auth)
      .send({ priceCents: 1 })
      .expect(200);
    expect((await t.http.get(`/api/v1/orders/${order.id}`).set(s.auth)).body.items[0].unitPriceCents).toBe(
      8990,
    );
    await t.http
      .patch(`/api/v1/admin/variants/${variant('blusa')}`)
      .set(c.auth)
      .send({ priceCents: 8990 })
      .expect(200);
  });

  it('changes nothing when it fails', async () => {
    await setStock(variant('blusa'), 10);
    const empty = await shopperWith([]);
    expect((await empty.place().expect(422)).body.error.code).toBe('CART_EMPTY');

    const s = await shopperWith([[variant('blusa'), 4]]);
    await setStock(variant('blusa'), 3);
    const short = await s.place().expect(409);
    expect(short.body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: [{ variantId: variant('blusa'), requested: 4, available: 3 }],
    });

    await t.http
      .patch(`/api/v1/admin/products/${c.products.blusa.id}`)
      .set(c.auth)
      .send({ status: 'archived' })
      .expect(200);
    expect((await s.place().expect(409)).body.error.code).toBe('CART_HAS_UNAVAILABLE_ITEMS');
    await t.http
      .patch(`/api/v1/admin/products/${c.products.blusa.id}`)
      .set(c.auth)
      .send({ status: 'active' })
      .expect(200);

    expect((await stock(variant('blusa'))).reserved).toBe(0);
    expect((await t.http.get('/api/v1/cart').set(s.auth)).body.items).toHaveLength(1);
    expect((await t.http.get('/api/v1/orders').set(s.auth)).body.data).toEqual([]);
  });
});

describe('idempotency', () => {
  it('replays the first response for a retried request', async () => {
    await setStock(variant('blusa'), 10);
    const s = await shopperWith([[variant('blusa'), 1]]);
    const first = await s.place({ 'Idempotency-Key': 'attempt-1' }).expect(201);
    const retry = await s.place({ 'Idempotency-Key': 'attempt-1' }).expect(201);

    expect(retry.body.id).toBe(first.body.id);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.headers.location).toBe(first.headers.location);
    const { rows } = await t.sql.query('SELECT count(*)::int AS n FROM orders WHERE user_id = $1', [
      s.userId,
    ]);
    expect(rows[0].n).toBe(1);

    // A new key is a new request, and the cart is now empty.
    expect((await s.place({ 'Idempotency-Key': 'attempt-2' }).expect(422)).body.error.code).toBe(
      'CART_EMPTY',
    );
  });

  it('lets a failed request be retried with the same key', async () => {
    const s = await shopperWith([]);
    await s.place({ 'Idempotency-Key': 'retry-me' }).expect(422);
    await t.http
      .post('/api/v1/cart/items')
      .set(s.auth)
      .send({ variantId: variant('vestidoLongo'), quantity: 1 })
      .expect(200);
    await s.place({ 'Idempotency-Key': 'retry-me' }).expect(201);
  });
});

describe('order history', () => {
  it('is private and paged newest first', async () => {
    await setStock(variant('blusa'), 20);
    const ana = await shopperWith([]);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      await t.http
        .post('/api/v1/cart/items')
        .set(ana.auth)
        .send({ variantId: variant('blusa'), quantity: 1 })
        .expect(200);
      ids.push((await ana.place().expect(201)).body.id);
    }
    const first = (await t.http.get('/api/v1/orders?limit=2').set(ana.auth).expect(200)).body;
    const second = (
      await t.http.get(`/api/v1/orders?limit=2&cursor=${first.nextCursor}`).set(ana.auth).expect(200)
    ).body;
    expect([...first.data, ...second.data].map((o: { id: string }) => o.id)).toEqual(ids.reverse());
    expect(second.nextCursor).toBeNull();
    expect(first.data[0].itemCount).toBe(1);

    const bia = await shopperWith([]);
    expect((await t.http.get('/api/v1/orders').set(bia.auth)).body.data).toEqual([]);
    await t.http.get(`/api/v1/orders/${ids[0]}`).set(bia.auth).expect(404);
    await t.http.post(`/api/v1/orders/${ids[0]}/cancel`).set(bia.auth).expect(404);
    await t.http.get('/api/v1/orders/not-an-id').set(ana.auth).expect(404);
  });
});

describe('status changes', () => {
  it('lets customers cancel unpaid orders, releasing stock and recording an event', async () => {
    await setStock(variant('blusa'), 10);
    const s = await shopperWith([[variant('blusa'), 2]]);
    const order = (await s.place().expect(201)).body;

    const cancelled = (await t.http.post(`/api/v1/orders/${order.id}/cancel`).set(s.auth).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'cancelled', expiresAt: null });
    expect(cancelled.statusHistory.at(-1)).toMatchObject({
      from: 'pending_payment',
      to: 'cancelled',
      reason: 'cancelled by customer',
    });
    expect((await stock(variant('blusa'))).reserved).toBe(0);

    const { rows } = await t.sql.query(
      `SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND type = 'order.status_changed'`,
      [order.id],
    );
    expect(rows[0].payload).toMatchObject({ from: 'pending_payment', to: 'cancelled' });

    const again = await t.http.post(`/api/v1/orders/${order.id}/cancel`).set(s.auth).expect(409);
    expect(again.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('lets admins fulfil paid orders through the state machine', async () => {
    await setStock(variant('blusa'), 10);
    const s = await shopperWith([[variant('blusa'), 1]]);
    const order = (await s.place().expect(201)).body;
    const path = `/api/v1/admin/orders/${order.id}/status`;

    expect(
      (await t.http.patch(path).set(c.auth).send({ status: 'shipped' }).expect(409)).body.error.code,
    ).toBe('INVALID_STATUS_TRANSITION');
    await t.http.patch(path).set(c.auth).send({ status: 'paid' }).expect(422);

    // Payment arrives in STEP 7; simulate it.
    await t.sql.query(`UPDATE orders SET status = 'paid', expires_at = NULL WHERE id = $1`, [order.id]);
    await t.http.patch(path).set(c.auth).send({ status: 'shipped', reason: 'Correios BR123' }).expect(200);
    const delivered = (await t.http.patch(path).set(c.auth).send({ status: 'delivered' }).expect(200)).body;
    expect(
      delivered.statusHistory.map((h: { to: string; reason: string }) => [h.to, h.reason]).slice(-2),
    ).toEqual([
      ['shipped', 'Correios BR123'],
      ['delivered', 'set by admin'],
    ]);

    const customer = await signUp(t);
    await t.http
      .patch(path)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ status: 'shipped' })
      .expect(403);
    const all = (await t.http.get('/api/v1/admin/orders?status=delivered').set(c.auth).expect(200)).body;
    expect(all.data.map((o: { id: string }) => o.id)).toContain(order.id);
  });
});

describe('concurrency', () => {
  it('never oversells when customers race for the last units', async () => {
    await setStock(variant('vestidoLongo'), 3);
    const shoppers = await Promise.all(
      Array.from({ length: 8 }, () => shopperWith([[variant('vestidoLongo'), 1]])),
    );
    const statuses = (await Promise.all(shoppers.map((s) => s.place()))).map((r) => r.status);
    expect(statuses.filter((code) => code === 201)).toHaveLength(3);
    expect(statuses.filter((code) => code === 409)).toHaveLength(5);
    expect(await stock(variant('vestidoLongo'))).toMatchObject({ onHand: 3, reserved: 3, available: 0 });
  });

  it('does not deadlock when orders share variants in opposite order', async () => {
    await setStock(variant('blusa'), 1000);
    await setStock(variant('vestidoMidi'), 1000);
    const shoppers = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        shopperWith(
          i % 2
            ? [
                [variant('blusa'), 1],
                [variant('vestidoMidi'), 1],
              ]
            : [
                [variant('vestidoMidi'), 1],
                [variant('blusa'), 1],
              ],
        ),
      ),
    );
    const statuses = (await Promise.all(shoppers.map((s) => s.place()))).map((r) => r.status);
    expect(statuses.every((code) => code === 201)).toBe(true);
    expect((await stock(variant('blusa'))).reserved).toBe(16);
  });
});
