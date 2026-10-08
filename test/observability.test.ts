import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerHttpServer } from '../src/jobs/worker-http.js';
import { refreshCookie, startTestApp, type TestApp } from './support/app.js';
import { type SeededCatalog, seedCatalog } from './support/catalog.js';
import { sendWebhook, session } from './support/webhooks.js';

let t: TestApp;
let c: SeededCatalog;
beforeAll(async () => {
  t = await startTestApp({ worker: true });
  c = await seedCatalog(t);
  await t.idle();
});
afterAll(() => t.close());

/** The value of the first series of `metric` whose labels include all of `labels`, or NaN. */
function sample(text: string, metric: string, ...labels: string[]): number {
  const line = text
    .split('\n')
    .find(
      (l) =>
        (l.startsWith(`${metric}{`) || l.startsWith(`${metric} `)) &&
        labels.every((label) => l.includes(label)),
    );
  return line ? Number(line.split(' ').at(-1)) : Number.NaN;
}

describe('metrics', () => {
  it('time requests by route pattern and expose queue and outbox gauges', async () => {
    await t.http.get('/api/v1/products/vestido-midi-linho').expect(200);
    await t.http.get('/api/v1/definitely-not-a-route').expect(404);

    const res = await t.http.get('/metrics').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    const text = res.text;
    expect(
      sample(
        text,
        'moda_http_request_duration_seconds_count',
        'route="/api/v1/products/:slug"',
        'status="200"',
      ),
    ).toBeGreaterThan(0);
    expect(
      sample(text, 'moda_http_request_duration_seconds_count', 'route="unmatched"', 'status="404"'),
    ).toBeGreaterThan(0);
    expect(text).not.toContain('vestido-midi-linho'); // IDs and slugs never become labels
    expect(sample(text, 'moda_queue_jobs', 'queue="notifications"', 'state="failed"')).toBeGreaterThanOrEqual(
      0,
    );
    expect(sample(text, 'moda_outbox_lag_seconds')).toBeGreaterThanOrEqual(0);
    expect(text).toContain('moda_process_cpu_seconds_total');
  });

  it('count jobs in the worker', async () => {
    await t.http.post('/api/v1/auth/password/forgot').send({ email: c.admin.email }).expect(202);
    await t.idle();

    const port = (t.worker as NonNullable<TestApp['worker']>).get(WorkerHttpServer).port;
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(
      sample(
        text,
        'moda_jobs_total',
        'queue="notifications"',
        'name="password-reset"',
        'outcome="completed"',
        'service="worker"',
      ),
    ).toBeGreaterThan(0);
    expect(text).toContain('moda_job_duration_seconds_bucket');
  });

  it('require the token when one is configured', async () => {
    const locked = await startTestApp({ env: { METRICS_TOKEN: 'scrape-token-1234567890' } });
    try {
      await locked.http.get('/metrics').expect(401);
      await locked.http.get('/metrics').set('Authorization', 'Bearer wrong-token-000000000').expect(401);
      await locked.http.get('/metrics').set('Authorization', 'Bearer scrape-token-1234567890').expect(200);
    } finally {
      await locked.close();
    }
  });
});

describe('logs', () => {
  it('are structured, correlated across processes and free of secrets', async () => {
    t.logs.length = 0;
    const password = 'S3cret-Passw0rd!';
    const email = 'carla.souza@example.com';
    const reg = await t.http
      .post('/api/v1/auth/register')
      .set('X-Request-ID', 'audit-register')
      .send({ email, password, name: 'Carla Souza' })
      .expect(201);
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    await t.http.post('/api/v1/auth/login').send({ email, password: `wrong-${password}` });
    await t.http.post('/api/v1/auth/refresh').set('Cookie', refreshCookie(reg));
    await t.http
      .post('/api/v1/auth/password/forgot')
      .set('X-Request-ID', 'audit-forgot')
      .send({ email })
      .expect(202);

    await t.http
      .post('/api/v1/cart/items')
      .set(auth)
      .send({ variantId: c.products.blusa.variantIds[0], quantity: 1 })
      .expect(200);
    const order = (
      await t.http.post('/api/v1/orders').set(auth).set('X-Request-ID', 'audit-order').expect(201)
    ).body;
    const co = (await t.http.post(`/api/v1/orders/${order.id}/checkout`).set(auth).expect(201)).body;
    const hook = sendWebhook(t, {
      id: 'evt_audit',
      type: 'checkout.session.completed',
      object: session(co.sessionId, order.totalCents, 'paid'),
    });
    await hook.expect(200);
    await t.idle();

    for (const line of t.logs) {
      expect(line).toMatchObject({
        level: expect.any(String),
        event: expect.any(String),
        service: 'moda-hub',
      });
    }
    // The worker's lines carry the request that started the chain.
    const fromForgot = t.logs.filter((l) => l.correlation_id === 'audit-forgot').map((l) => l.event);
    expect(fromForgot).toEqual(expect.arrayContaining(['mail.sent', 'job.completed']));
    const fromOrder = t.logs.filter((l) => l.correlation_id === 'audit-order').map((l) => l.event);
    expect(fromOrder).toContain('mail.sent');

    const resetMail = t.mailer.to(email).find((m) => m.subject.startsWith('Redefina'));
    const resetToken = decodeURIComponent(/token=(\S+)/.exec(resetMail?.text ?? '')?.[1] ?? '');
    const raw = JSON.stringify(t.logs);
    for (const [name, secret] of [
      ['password', password],
      ['access token', reg.body.accessToken],
      ['refresh token', refreshCookie(reg).split('=')[1]],
      ['reset token', resetToken],
      ['email', email],
      ['name', 'Carla Souza'],
      ['webhook secret', 'whsec_test_secret'],
    ] as const) {
      expect(secret, name).toBeTruthy();
      expect(raw.includes(secret as string), `${name} leaked into logs`).toBe(false);
    }
  });
});
