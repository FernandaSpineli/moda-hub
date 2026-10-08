import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '../src/jobs/queues.js';
import { signUp, startTestApp, type TestApp } from './support/app.js';
import { type SeededCatalog, seedCatalog } from './support/catalog.js';
import { sendWebhook, session } from './support/webhooks.js';

let t: TestApp;
let c: SeededCatalog;
beforeAll(async () => {
  // A 2-second reservation, so expiry can be watched happening.
  t = await startTestApp({ worker: true, env: { ORDER_RESERVATION_TTL: '2s' } });
  c = await seedCatalog(t);
  await t.idle();
});
afterAll(() => t.close());

const blusa = () => c.products.blusa.variantIds[0] as string;
const queue = (name: string) => t.app.get<Queue>(getQueueToken(name));

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (ok(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`condition not met in ${timeoutMs}ms; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function customerWithOrder(quantity = 1, headers: Record<string, string> = {}) {
  await t.sql.query('UPDATE inventory SET on_hand = on_hand + $2 WHERE variant_id = $1', [blusa(), quantity]);
  const user = await signUp(t);
  const auth = { Authorization: `Bearer ${user.token}` };
  await t.http.post('/api/v1/cart/items').set(auth).send({ variantId: blusa(), quantity }).expect(200);
  const order = (await t.http.post('/api/v1/orders').set(auth).set(headers).expect(201)).body;
  return { ...user, auth, order };
}

const orderStatus = async (id: string) =>
  (await t.sql.query('SELECT status FROM orders WHERE id = $1', [id])).rows[0]?.status as string;

describe('outbox relay', () => {
  it('publishes every event once, with the request that caused it', async () => {
    const { order } = await customerWithOrder(1, { 'X-Request-ID': 'trace-outbox-1' });
    await t.idle();

    const { rows } = await t.sql.query(
      'SELECT id, published_at FROM outbox_events WHERE aggregate_id = $1 AND type = $2',
      [order.id, 'order.placed'],
    );
    expect(rows[0].published_at).not.toBeNull();

    // Job IDs derive from the event ID, which is what deduplicates re-publishing.
    const confirmation = await queue(QUEUES.notifications).getJob(`${rows[0].id}.order-confirmation`);
    expect(confirmation?.data.correlationId).toBe('trace-outbox-1');

    // The job's own log lines carry the original request ID.
    const jobLogs = t.logs.filter(
      (l) => l.queue === QUEUES.notifications && l.correlation_id === 'trace-outbox-1',
    );
    expect(jobLogs.map((l) => l.event)).toEqual(expect.arrayContaining(['mail.sent', 'job.completed']));
  });
});

describe('notifications', () => {
  it('email a single-use reset link whose token is never stored in plain text', async () => {
    const { email } = await signUp(t);
    await t.http.post('/api/v1/auth/password/forgot').send({ email }).expect(202);
    await t.idle();

    const [mail] = t.mailer.to(email);
    expect(mail?.subject).toBe('Redefina sua senha da Moda Hub');
    const token = decodeURIComponent(/token=(\S+)/.exec(mail?.text ?? '')?.[1] ?? '');
    expect(token).toHaveLength(43);

    const stored = JSON.stringify(
      (
        await t.sql.query('SELECT payload FROM outbox_events WHERE type = $1', [
          'auth.password_reset_requested',
        ])
      ).rows,
    );
    expect(stored).not.toContain(token);
    expect(JSON.stringify(t.logs)).not.toContain(token);

    await t.http
      .post('/api/v1/auth/password/reset')
      .send({ token, newPassword: 'brand-new-pass' })
      .expect(204);
    await t.http.post('/api/v1/auth/login').send({ email, password: 'brand-new-pass' }).expect(200);
  });

  it('follow an order: placed, paid, shipped', async () => {
    const { email, auth, order } = await customerWithOrder(2);
    const co = (await t.http.post(`/api/v1/orders/${order.id}/checkout`).set(auth).expect(201)).body;
    await t.idle();
    expect(t.mailer.to(email).map((m) => m.subject)).toEqual([
      expect.stringMatching(/^Recebemos seu pedido #/),
    ]);

    await sendWebhook(t, {
      id: `evt_${order.id}`,
      type: 'checkout.session.completed',
      object: session(co.sessionId, order.totalCents, 'paid'),
    }).expect(200);
    await t.idle();
    expect(await orderStatus(order.id)).toBe('paid');

    await t.http
      .patch(`/api/v1/admin/orders/${order.id}/status`)
      .set(c.auth)
      .send({ status: 'shipped', reason: 'Rastreio: BR123' })
      .expect(200);
    await t.idle();
    const subjects = t.mailer.to(email).map((m) => m.subject);
    expect(subjects).toHaveLength(3);
    expect(subjects[1]).toMatch(/^Pagamento confirmado/);
    expect(subjects[2]).toMatch(/foi enviado$/);
    expect(t.mailer.to(email)[2]?.text).toContain('Rastreio: BR123');
  });

  it('warn admins when a sale leaves a variant at or below its threshold', async () => {
    await t.sql.query(
      'UPDATE inventory SET on_hand = reserved + 4, low_stock_threshold = 3 WHERE variant_id = $1',
      [blusa()],
    );
    const user = await signUp(t);
    const auth = { Authorization: `Bearer ${user.token}` };
    await t.http.post('/api/v1/cart/items').set(auth).send({ variantId: blusa(), quantity: 2 }).expect(200);
    const order = (await t.http.post('/api/v1/orders').set(auth).expect(201)).body;
    const co = (await t.http.post(`/api/v1/orders/${order.id}/checkout`).set(auth).expect(201)).body;
    await sendWebhook(t, {
      id: `evt_low_${order.id}`,
      type: 'checkout.session.completed',
      object: session(co.sessionId, order.totalCents, 'paid'),
    }).expect(200);
    await t.idle();

    const alert = t.mailer.to(c.admin.email).find((m) => m.subject.startsWith('Estoque baixo'));
    expect(alert?.text).toContain('BA-PP-BR (Blusa de Algodão): 2 disponível(is)');
  });

  it('send each email once even if a job is delivered twice', async () => {
    const { email, order } = await customerWithOrder();
    await t.idle();
    const { rows } = await t.sql.query(
      `SELECT id FROM outbox_events WHERE aggregate_id = $1 AND type = 'order.placed'`,
      [order.id],
    );
    // Simulate an at-least-once redelivery under a different job ID.
    await queue(QUEUES.notifications).add(
      'order-confirmation',
      {
        eventId: rows[0].id,
        payload: {
          orderId: order.id,
          userId: (await t.sql.query('SELECT user_id FROM orders WHERE id = $1', [order.id])).rows[0].user_id,
        },
      },
      { jobId: `redelivery-${order.id}` },
    );
    await t.idle();
    expect(t.mailer.to(email)).toHaveLength(1);
    expect(t.logs.some((l) => l.event === 'job.duplicate_skipped')).toBe(true);
  });
});

describe('retries and the dead-letter queue', () => {
  it('retry a failing send with backoff until it succeeds', async () => {
    t.mailer.failures = 2;
    const { email } = await customerWithOrder();
    await t.idle();
    expect(t.mailer.to(email)).toHaveLength(1);
    expect(t.logs.filter((l) => l.event === 'job.failed_will_retry').length).toBeGreaterThanOrEqual(2);
  });

  it('dead-letter a job that keeps failing, and let an admin retry it', async () => {
    t.mailer.failures = Number.POSITIVE_INFINITY;
    const { email, auth, order } = await customerWithOrder();
    // Checkout extends the 2-second reservation, so the order cannot expire mid-test.
    await t.http.post(`/api/v1/orders/${order.id}/checkout`).set(auth).expect(201);
    await t.idle();
    expect(t.mailer.to(email)).toHaveLength(0);
    expect(t.logs.some((l) => l.event === 'job.dead_lettered')).toBe(true);

    const failed = (await t.http.get('/api/v1/admin/jobs/failed?queue=notifications').set(c.auth).expect(200))
      .body.data;
    const job = failed.find(
      (j: { name: string; data: { payload: { orderId: string } } }) =>
        j.name === 'order-confirmation' && j.data.payload.orderId === order.id,
    );
    expect(job).toMatchObject({ queue: 'notifications', name: 'order-confirmation', attemptsMade: 5 });
    expect(job.failedReason).toContain('SMTP 421');

    t.mailer.failures = 0;
    await t.http.post(`/api/v1/admin/jobs/notifications/${job.id}/retry`).set(c.auth).expect(202);
    await t.idle();
    expect(t.mailer.to(email)).toHaveLength(1);

    await t.http.post('/api/v1/admin/jobs/notifications/no-such-job/retry').set(c.auth).expect(404);
    const customer = await signUp(t);
    await t.http
      .get('/api/v1/admin/jobs/failed')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(403);
  });
});

describe('order expiry', () => {
  it('expires an unpaid order when its delayed job comes due, releasing stock', async () => {
    const { email, order } = await customerWithOrder(1);

    await eventually(
      () => orderStatus(order.id),
      (s) => s === 'expired',
    );
    await t.idle();
    // Reserved stock always equals what unpaid orders still hold.
    const { rows } = await t.sql.query(
      `SELECT i.reserved,
              (SELECT COALESCE(sum(oi.quantity), 0)::int FROM order_items oi JOIN orders o ON o.id = oi.order_id
               WHERE oi.variant_id = i.variant_id AND o.status = 'pending_payment') AS held
       FROM inventory i WHERE i.variant_id = $1`,
      [blusa()],
    );
    expect(rows[0].reserved).toBe(rows[0].held);
    expect(t.mailer.to(email).map((m) => m.subject)).toContainEqual(expect.stringMatching(/expirou$/));
  });

  it('reschedules instead of expiring when checkout extended the reservation', async () => {
    const { auth, order } = await customerWithOrder(1);
    await t.http.post(`/api/v1/orders/${order.id}/checkout`).set(auth).expect(201);

    await eventually(
      () => queue(QUEUES.orderExpiry).getJobs(['delayed']),
      (jobs) => jobs.some((j) => j.id?.startsWith(`${order.id}.expire.`)),
    );
    expect(await orderStatus(order.id)).toBe('pending_payment');
    expect(t.logs.some((l) => l.event === 'order.expiry_rescheduled' && l.order_id === order.id)).toBe(true);
  });

  it('catches orders whose job was lost with the periodic sweep', async () => {
    const { order } = await customerWithOrder(1);
    await t.idle();
    // Lose the delayed job, as if Redis had been wiped.
    for (const job of await queue(QUEUES.orderExpiry).getJobs(['delayed'])) {
      if (job.data.payload.orderId === order.id) await job.remove();
    }
    await t.sql.query(`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = $1`, [order.id]);

    await queue(QUEUES.orderExpiry).add('sweep', { eventId: 'sweep', payload: {} });
    await eventually(
      () => orderStatus(order.id),
      (s) => s === 'expired',
    );
  });
});
