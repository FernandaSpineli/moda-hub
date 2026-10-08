import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { refreshCookie, signUp, startTestApp, type TestApp } from './support/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

const register = (body: object) => t.http.post('/api/v1/auth/register').send(body);
const login = (email: string, password: string) =>
  t.http.post('/api/v1/auth/login').send({ email, password });
const refresh = (cookie: string) => t.http.post('/api/v1/auth/refresh').set('Cookie', cookie);
const fields = (res: { body: { error: { details: { field: string }[] } } }) =>
  res.body.error.details.map((d) => d.field);

describe('register', () => {
  it('creates an account and starts a session', async () => {
    const res = await register({ email: '  Ana@Example.com ', password: 'password123', name: 'Ana' }).expect(
      201,
    );
    expect(res.body.user).toMatchObject({ email: 'ana@example.com', name: 'Ana', role: 'customer' });
    expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, accessToken: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/password|refresh/i);

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('refresh_token='),
    );
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('rejects a duplicate email regardless of case', async () => {
    await register({ email: 'bia@example.com', password: 'password123', name: 'Bia' }).expect(201);
    const res = await register({ email: 'BIA@example.com', password: 'password123', name: 'Bia' }).expect(
      409,
    );
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('reports every invalid field', async () => {
    const res = await register({ email: 'Ana <ana@example.com>', password: 'short', name: ' ' }).expect(422);
    expect(fields(res)).toEqual(expect.arrayContaining(['email', 'password', 'name']));
  });

  it('refuses fields a client must not set', async () => {
    const res = await register({
      email: 'c@example.com',
      password: 'password123',
      name: 'C',
      role: 'admin',
    }).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('login', () => {
  it('accepts the right password, case-insensitive email', async () => {
    const { email } = await signUp(t);
    const res = await login(email.toUpperCase(), 'password123').expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it('fails identically for a wrong password and an unknown email', async () => {
    const { email } = await signUp(t);
    const wrong = await login(email, 'wrong-password').expect(401);
    const unknown = await login('nobody@example.com', 'wrong-password').expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });
});

describe('authentication guard', () => {
  it('protects every non-public route', async () => {
    const res = await t.http.get('/api/v1/users/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    await t.http.get('/api/v1/users/me').set('Authorization', 'Bearer forged.token.value').expect(401);
    await t.http.get('/api/v1/users/me').set('Authorization', 'Basic abc').expect(401);
  });

  it('lets a valid token through and records who called', async () => {
    const { token, userId } = await signUp(t);
    t.logs.length = 0;
    const res = await t.http.get('/api/v1/users/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toMatchObject({ id: userId, role: 'customer' });
    const access = t.logs.find((l) => l.event === 'http.request');
    expect(access?.user_id).toBe(userId);
  });

  it('publishes a JWKS that verifies issued tokens', async () => {
    const { token, userId } = await signUp(t);
    const jwks = (await t.http.get('/.well-known/jwks.json').expect(200)).body;
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      algorithms: ['EdDSA'],
      issuer: 'moda-hub',
      audience: 'moda-hub-api',
    });
    expect(payload.sub).toBe(userId);
  });
});

describe('profile', () => {
  it('updates the name but never the email or role', async () => {
    const { token } = await signUp(t);
    const auth = { Authorization: `Bearer ${token}` };
    const res = await t.http.patch('/api/v1/users/me').set(auth).send({ name: '  Ana Maria ' }).expect(200);
    expect(res.body.name).toBe('Ana Maria');
    await t.http.patch('/api/v1/users/me').set(auth).send({ email: 'evil@example.com' }).expect(422);
    await t.http.patch('/api/v1/users/me').set(auth).send({ role: 'admin' }).expect(422);
    await t.http.patch('/api/v1/users/me').set(auth).send({ name: '' }).expect(422);
  });
});

describe('refresh tokens', () => {
  it('rotate on use and revoke every session when a used one is replayed', async () => {
    const { cookie: first } = await signUp(t);

    const rotated = await refresh(first).expect(200);
    const second = refreshCookie(rotated);
    expect(rotated.body).toMatchObject({ tokenType: 'Bearer', accessToken: expect.any(String) });
    expect(second).not.toBe(first);

    // Replaying the old token is treated as theft...
    const replay = await refresh(first).expect(401);
    expect(replay.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    // ...and the session issued from it is revoked too.
    await refresh(second).expect(401);
  });

  it('are required to refresh', async () => {
    await t.http.post('/api/v1/auth/refresh').expect(401);
    await refresh('refresh_token=made-up').expect(401);
  });

  it('stop working after logout, which clears the cookie', async () => {
    const { cookie } = await signUp(t);
    const res = await t.http.post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(
      /refresh_token=;.*Expires=Thu, 01 Jan 1970/,
    );
    await refresh(cookie).expect(401);
    // Logging out without a session reveals nothing.
    await t.http.post('/api/v1/auth/logout').expect(204);
  });
});

describe('password change', () => {
  it('checks the current password, then signs out every other session', async () => {
    const { token, cookie, email } = await signUp(t);
    const auth = { Authorization: `Bearer ${token}` };

    const wrong = await t.http
      .put('/api/v1/users/me/password')
      .set(auth)
      .send({ currentPassword: 'nope', newPassword: 'new-password-1' })
      .expect(422);
    expect(fields(wrong)).toEqual(['currentPassword']);

    await t.http
      .put('/api/v1/users/me/password')
      .set(auth)
      .send({ currentPassword: 'password123', newPassword: 'new-password-1' })
      .expect(204);
    await refresh(cookie).expect(401);
    await login(email, 'password123').expect(401);
    await login(email, 'new-password-1').expect(200);
  });
});

describe('password reset', () => {
  it('records a reset request in the outbox without revealing whether the account exists', async () => {
    const { email, userId } = await signUp(t);
    const requestId = 'reset-trace-1';

    const known = await t.http
      .post('/api/v1/auth/password/forgot')
      .set('X-Request-ID', requestId)
      .send({ email });
    const unknown = await t.http.post('/api/v1/auth/password/forgot').send({ email: 'nobody@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);

    const { rows } = await t.sql.query(
      `SELECT type, payload, correlation_id, published_at FROM outbox_events WHERE aggregate_id = $1`,
      [userId],
    );
    expect(rows).toEqual([
      {
        type: 'auth.password_reset_requested',
        payload: { userId },
        correlation_id: requestId,
        published_at: null,
      },
    ]);
  });

  it('accepts a token once, then revokes every session', async () => {
    const { email, userId, cookie } = await signUp(t);
    const issued = await t.app.get(AuthService).issuePasswordResetToken(userId);
    if (!issued) throw new Error('no token issued');

    await t.http
      .post('/api/v1/auth/password/reset')
      .send({ token: issued.token, newPassword: 'brand-new-pass' })
      .expect(204);
    const again = await t.http
      .post('/api/v1/auth/password/reset')
      .send({ token: issued.token, newPassword: 'another-pass-1' })
      .expect(400);
    expect(again.body.error.code).toBe('INVALID_RESET_TOKEN');
    await refresh(cookie).expect(401);
    await login(email, 'brand-new-pass').expect(200);
  });

  it('honours only the latest link', async () => {
    const { userId } = await signUp(t);
    const auth = t.app.get(AuthService);
    const first = await auth.issuePasswordResetToken(userId);
    await auth.issuePasswordResetToken(userId);
    await t.http
      .post('/api/v1/auth/password/reset')
      .send({ token: first?.token, newPassword: 'brand-new-pass' })
      .expect(400);
  });
});

describe('logs', () => {
  it('never contain passwords, tokens or emails', async () => {
    t.logs.length = 0;
    const password = 'S3cret-Passw0rd!';
    const reg = await register({ email: 'carla@example.com', password, name: 'Carla Souza' }).expect(201);
    await login('carla@example.com', `wrong-${password}`);
    await refresh(refreshCookie(reg));

    const raw = JSON.stringify(t.logs);
    for (const secret of [
      password,
      reg.body.accessToken,
      refreshCookie(reg).split('=')[1],
      'carla@example.com',
    ]) {
      expect(raw).not.toContain(secret);
    }
    const events = t.logs.map((l) => l.event);
    expect(events).toEqual(expect.arrayContaining(['auth.user.registered', 'auth.login.failed']));
  });
});
