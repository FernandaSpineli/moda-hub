# ADR 003 — Authentication: EdDSA access tokens and rotating refresh cookies

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Shoppers sign in from a browser (the storefront, or any frontend on the same
site); other services may need to verify who a request is from. Sessions
must be revocable, a stolen token must be short-lived, and the design must
not depend on the browser storing a long-lived secret where scripts can read
it.

## Decisions

**Access token:** a JWT signed with Ed25519 (`EdDSA`), valid for 15 minutes,
carrying the user ID and role. It is returned in the response body and kept
in memory by the client. The public key is published at
`/.well-known/jwks.json` with a `kid`, so other services can verify tokens
without sharing a secret, and keys can be rotated.

**Refresh token:** 256 random bits, stored only as a SHA-256 hash, sent as an
`HttpOnly`, `SameSite=Strict` cookie, `Secure` whenever `APP_BASE_URL` is
https, whose
`Path` is `/api/v1/auth`, so it never travels with other requests. Each
refresh **rotates** it. A token presented after it was rotated means it was
copied: every session of that user is revoked and the event is logged.

**Passwords:** argon2id (64 MiB, 3 iterations). Login runs the hash even for
unknown emails, so timing does not reveal which accounts exist; the password
reset request answers the same either way.

**Password reset:** a single-use token valid for 30 minutes, stored hashed.
The worker generates it when it sends the email, so it never sits in the
outbox or a queue in clear. Resetting revokes every session.

**Authorisation:** a global guard denies every route unless it is marked
`@Public()` or presents a valid token; admin routes add
`@RequireRole('admin')`. No HTTP endpoint grants a role: admins are created
with `node dist/cli.js user promote <email>`.

**Rate limits** (Redis, shared by all instances): login per IP and per email,
sign-up and reset per IP, reset emails per inbox. They fail open if Redis is
down. `TRUST_PROXY` must name the proxies that may report the client IP.

## Consequences

- An access token cannot be revoked before it expires; 15 minutes bounds
  that. Role changes take effect at the next refresh.
- `SameSite=Strict` plus the narrow cookie path stand in for CSRF tokens on
  the refresh endpoint; a frontend on another site would need a different
  arrangement.
