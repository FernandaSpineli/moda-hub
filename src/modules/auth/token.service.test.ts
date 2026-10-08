import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/config.js';
import { hashToken, InvalidAccessTokenError, opaqueToken, TokenService } from './token.service.js';

function service() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const config = { auth: { signingKey: privateKey, accessTokenTtlMs: 15 * 60_000 } } as AppConfig;
  return { svc: new TokenService(config), privateKey };
}

const principal = { userId: '01a11699-7a06-7d19-ace9-45b3da7b647b', role: 'customer' as const };

describe('TokenService', () => {
  it('round-trips a principal', async () => {
    const { svc } = service();
    await expect(svc.verify(await svc.issue(principal))).resolves.toEqual(principal);
  });

  it('publishes a JWKS that verifies its tokens', async () => {
    const { svc } = service();
    const token = await svc.issue(principal);
    const jwks = await svc.jwks();
    expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
    expect(jwks.keys[0]).not.toHaveProperty('d'); // never the private part
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), { algorithms: ['EdDSA'] });
    expect(payload.sub).toBe(principal.userId);
  });

  const forgeries: [string, (svc: TokenService) => Promise<string>][] = [
    ['expired', (svc) => svc.issue(principal, Date.now() - 16 * 60_000)],
    [
      'signed by another key',
      async () => {
        const other = service().svc;
        return other.issue(principal);
      },
    ],
    [
      'unsigned (alg: none)',
      async () => new UnsecuredJWT({ role: 'admin' }).setSubject(principal.userId).encode(),
    ],
    [
      'HS256 with a guessable secret',
      async () =>
        new SignJWT({ role: 'admin' })
          .setProtectedHeader({ alg: 'HS256' })
          .setSubject(principal.userId)
          .setIssuer('moda-hub')
          .setAudience('moda-hub-api')
          .setExpirationTime('5m')
          .sign(new TextEncoder().encode('public-key-material-as-secret')),
    ],
    [
      'with a tampered role',
      async (svc) => {
        const [h, p, s] = (await svc.issue(principal)).split('.');
        const payload = JSON.parse(Buffer.from(p as string, 'base64url').toString());
        payload.role = 'admin';
        return [h, Buffer.from(JSON.stringify(payload)).toString('base64url'), s].join('.');
      },
    ],
    [
      'for another audience',
      async () => {
        const { svc: _svc, privateKey } = service();
        return new SignJWT({ role: 'customer' })
          .setProtectedHeader({ alg: 'EdDSA' })
          .setSubject(principal.userId)
          .setIssuer('moda-hub')
          .setAudience('someone-else')
          .setExpirationTime('5m')
          .sign(privateKey);
      },
    ],
    ['garbage', async () => 'not.a.jwt'],
  ];

  it.each(forgeries)('rejects a token that is %s', async (_name, make) => {
    const { svc } = service();
    await expect(svc.verify(await make(svc))).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });
});

describe('opaqueToken', () => {
  it('is random, URL-safe and stored only as a hash', () => {
    const a = opaqueToken();
    const b = opaqueToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash.equals(hashToken(a.token))).toBe(true);
    expect(a.hash.toString('hex')).not.toContain(a.token);
  });
});
