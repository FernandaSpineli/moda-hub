import { createHash, createPublicKey, type KeyObject, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { calculateJwkThumbprint, exportJWK, type JWK, jwtVerify, SignJWT } from 'jose';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { type Principal, type Role, roles } from './principal.js';

const ISSUER = 'moda-hub';
const AUDIENCE = 'moda-hub-api';
const ALG = 'EdDSA';

export class InvalidAccessTokenError extends Error {
  override name = 'InvalidAccessTokenError';
}

/**
 * Issues and verifies access tokens: short-lived JWTs signed with Ed25519.
 * Only this service holds the private key; anything with the public key
 * (published at /.well-known/jwks.json) can verify tokens but never mint
 * them. Access tokens are not checked against the database, so a role
 * change takes effect within one TTL — the trade-off for stateless requests.
 */
@Injectable()
export class TokenService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly ttlMs: number;
  private kid?: Promise<string>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.privateKey = config.auth.signingKey;
    this.publicKey = createPublicKey(this.privateKey);
    this.ttlMs = config.auth.accessTokenTtlMs;
  }

  get ttlSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  async issue(principal: Principal, now = Date.now()): Promise<string> {
    return new SignJWT({ role: principal.role })
      .setProtectedHeader({ alg: ALG, kid: await this.keyId() })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(principal.userId)
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor((now + this.ttlMs) / 1000))
      .setJti(randomUUID())
      .sign(this.privateKey);
  }

  async verify(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        // Pinning the algorithm blocks "alg: none" and algorithm confusion.
        algorithms: [ALG],
        issuer: ISSUER,
        audience: AUDIENCE,
        requiredClaims: ['sub', 'exp'],
      });
      const role = payload.role as Role;
      if (!payload.sub || !roles.includes(role)) throw new Error('missing subject or unknown role');
      return { userId: payload.sub, role };
    } catch (err) {
      throw new InvalidAccessTokenError((err as Error).message);
    }
  }

  /** The public key as a JSON Web Key Set. */
  async jwks(): Promise<{ keys: JWK[] }> {
    const jwk = await exportJWK(this.publicKey);
    return { keys: [{ ...jwk, kid: await this.keyId(), alg: ALG, use: 'sig' }] };
  }

  private keyId(): Promise<string> {
    this.kid ??= exportJWK(this.publicKey).then((jwk) => calculateJwkThumbprint(jwk));
    return this.kid;
  }
}

/**
 * A random token for refresh and password-reset links, and its SHA-256
 * hash. Only the hash is stored: with 256 bits of entropy a fast hash is
 * enough, and a leaked table yields nothing usable.
 */
export function opaqueToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
