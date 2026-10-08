# Moda Hub

[![CI](https://github.com/FernandaSpineli/moda-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/FernandaSpineli/moda-hub/actions/workflows/ci.yml)

E-commerce backend for a women's fashion store, in TypeScript with NestJS:
a catalogue of products in sizes and colours, a cart, orders that reserve
stock, Stripe Checkout (card, Pix, boleto), and a worker that sends email,
applies payments and expires unpaid orders. Prices are in BRL.

It comes with a small storefront served by the API, so the whole flow can be
tried in a browser.

**Stack:** Node.js 24 · NestJS 12 · TypeScript 6 · PostgreSQL 18 · Drizzle ORM ·
Redis 8 · BullMQ · Stripe · Zod · Pino · Prometheus · Vitest + Testcontainers ·
Docker · GitHub Actions

## Highlights

- **Fashion catalogue.** Category tree; variants per size × colour with their
  own SKU, price, "was" price and stock; photos per colour; sizes sorted the
  way shoppers expect (PP < P < M < G < GG, 34 < 36 < …). Portuguese search
  that ignores accents ("algodao" finds "algodão", "vestidos" finds
  "vestido"); size and colour filters that must hold for the *same* variant;
  keyset (cursor) pagination.
- **Stock that cannot oversell.** Placing an order reserves stock under row
  locks taken in a fixed order (no deadlocks), and database CHECKs make a
  negative stock impossible. Unpaid orders expire and release their stock.
- **Payments you can trust.** Stripe Checkout sessions created with
  idempotency keys; webhooks verified, stored, then applied by the worker
  exactly once; the paid amount is checked against the order; late or double
  payments are flagged for refund instead of being lost.
- **Reliable side effects.** A transactional outbox and BullMQ queues with
  retries, backoff and a dead-letter queue an admin can inspect and retry
  ([ADR 001](docs/decisions/001-async-processing.md)).
- **Security.** Argon2id; short-lived EdDSA access tokens with a public JWKS;
  rotating refresh tokens in HttpOnly cookies, with reuse detection; routes
  closed unless marked public; admins created only from the CLI; rate limits
  on login, sign-up and password reset; strict input validation that names
  unknown fields; secrets never logged.
- **Operable.** Structured JSON logs with a correlation ID that follows a
  request into the worker's jobs; Prometheus metrics for requests, queues,
  jobs and outbox lag; liveness and readiness probes; graceful shutdown.

## Run it

Requirements: Docker. For development without Docker for the app: Node.js 24
and pnpm (via `corepack enable`).

```bash
cp .env.example .env
# Fill in a fresh signing key:
sed -i "s|^JWT_PRIVATE_KEY=.*|$(node scripts/generate-jwt-key.mjs)|" .env
docker compose up -d --build --wait
docker compose run --rm api node dist/cli.js seed-demo
```

| What | Where |
| --- | --- |
| Storefront | http://localhost:3000 |
| API docs (Swagger UI) | http://localhost:3000/docs |
| OpenAPI document | http://localhost:3000/docs/openapi.json |
| Emails sent (Mailpit) | http://localhost:8025 |
| Metrics | http://localhost:3000/metrics (API), `:3001/metrics` inside the worker container |

To manage the catalogue and orders, register an account and promote it:

```bash
docker compose run --rm api node dist/cli.js user promote you@example.com
```

### Payments

Without Stripe keys everything works except checkout, which answers `503
PAYMENTS_UNAVAILABLE`. To try payments, use **test-mode** keys:

```bash
# .env
STRIPE_SECRET_KEY=sk_test_...
docker compose --profile stripe up -d          # starts the Stripe CLI forwarder
docker compose logs stripe | grep whsec_       # copy it to STRIPE_WEBHOOK_SECRET
docker compose up -d                           # restart api and worker with it
```

Pay with card `4242 4242 4242 4242`, any future date and any CVC.

## Develop

```bash
corepack enable
pnpm install
pnpm test            # unit + integration (starts PostgreSQL, Redis, Mailpit in containers)
pnpm test:unit       # no Docker needed
pnpm test:cov        # with coverage
pnpm lint            # Biome
pnpm typecheck
pnpm dev             # API with reload; needs PostgreSQL and Redis (docker compose up -d postgres redis)
```

Database changes: edit `src/db/schema`, run `pnpm db:generate`, review the
SQL in `drizzle/`, and commit both. Migrations run on startup in Docker (the
`migrate` service) or with `node dist/cli.js migrate`.

## API

All JSON, camelCase, under `/api/v1`. Money is integer cents. Errors look like:

```json
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "Not enough units in stock",
             "details": { "requested": 3, "available": 1 }, "request_id": "..." } }
```

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/password/forgot`, `/auth/password/reset`; `GET /.well-known/jwks.json` |
| Profile | `GET`/`PATCH /users/me`, `PUT /users/me/password` |
| Catalogue | `GET /categories`, `GET /products` (filters: `q`, `category`, `size`, `color`, `minPrice`, `maxPrice`, `onSale`, `inStock`, `sort`, `cursor`, `limit`), `GET /products/{slug}` |
| Cart | `GET`/`DELETE /cart`, `POST /cart/items`, `PATCH`/`DELETE /cart/items/{variantId}` |
| Orders | `POST /orders` (send `Idempotency-Key`), `GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/cancel` |
| Payments | `POST /orders/{id}/checkout`, `POST /payments/webhook` (Stripe) |
| Admin | categories, products, variants, images and stock under `/admin`; `GET /admin/orders`, `PATCH /admin/orders/{id}/status`; `GET /admin/jobs/failed`, `POST /admin/jobs/{queue}/{id}/retry` |
| Operations | `GET /health`, `GET /ready`, `GET /metrics` |

The full contract, with every request schema, is at `/docs`.

## Documentation

- [Architecture](docs/architecture.md): modules, request and order flows, data model.
- Decisions: [001 asynchronous processing](docs/decisions/001-async-processing.md) ·
  [002 stack](docs/decisions/002-stack.md) ·
  [003 authentication](docs/decisions/003-authentication.md) ·
  [004 payments](docs/decisions/004-payments.md) ·
  [005 stock reservation](docs/decisions/005-stock-reservation.md)

## Configuration

All settings come from environment variables, validated at startup; see
[`.env.example`](.env.example) for every one, with comments. The app refuses
to start with an invalid value and says which.
