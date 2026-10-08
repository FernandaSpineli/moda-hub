# Architecture

Moda Hub is one codebase that runs as two processes from the same Docker
image, sharing PostgreSQL and Redis:

```
                 ┌──────────────────────────── API (dist/main.js) ─────────────────────────────┐
 browser ──────► │ storefront · /docs · /api/v1/*  ── guards ── controllers ── services ──┐    │
 Stripe ───────► │ /api/v1/payments/webhook (verify, store)                               │    │
 Prometheus ───► │ /metrics                                                               │    │
                 └────────────────────────────────────────────────────────────────────────┼────┘
                                                                                          ▼
                                                        PostgreSQL ◄── one transaction: change + outbox event
                                                            │
                 ┌──────────────── worker (dist/worker.js) ─┼──────────────────────────────────┐
                 │ outbox relay ──► BullMQ queues (Redis) ──► processors ──► email (SMTP)       │
                 │                  stripe-events · notifications · order-expiry ·             │
                 │                  inventory-alerts                                           │
                 │ /health · /metrics on :3001                                                 │
                 └─────────────────────────────────────────────────────────────────────────────┘
```

The API never waits on email or on applying a payment; the worker never
serves shoppers. Both scale horizontally: the relay claims outbox rows with
`SKIP LOCKED`, BullMQ hands each job to one worker, and rate limits and
idempotency keys live in Redis, not in memory.

## Code layout

```
src/
  main.ts, app.ts, app.module.ts     API process: Nest app, global guard, filters, middleware
  worker.ts, worker.module.ts        worker process: relay, processors, small HTTP server
  cli.ts                             migrate · seed-demo · user promote
  config/                            env validation (Zod) into a typed AppConfig; Secret wrapper
  platform/                          database pool, Redis, mailer, metrics: shared by both processes
  common/                            errors, validation pipe, request context, logging, rate limit,
                                     idempotency, OpenAPI helpers
  db/schema/                         Drizzle tables (the source of truth for migrations)
  modules/
    auth/       register, login, refresh rotation, password reset, guard, JWKS
    users/      profile
    catalog/    categories, products, variants, images, search and filters
    inventory/  stock levels, reservations, low-stock threshold
    cart/       one cart per user, totals, free shipping
    orders/     placing, state machine, cancellation, expiry, admin
    payments/   Stripe Checkout, webhook intake and application
    notifications/ email templates (pt-BR)
  jobs/        outbox relay, queue definitions, job runner, processors, dead-letter admin
  storefront/  serves public/index.html with a hashed CSP
drizzle/        generated SQL migrations, plus hand-written ones (extensions, triggers)
test/           integration and API tests (Testcontainers); unit tests sit next to the code
```

Modules talk through their services; controllers stay thin (parse, call,
return). Database access is in services or small repositories, with SQL
written out where it matters (locking, search, recursive category queries).

## A request

1. `RequestContextMiddleware` assigns a correlation ID (or accepts a sane
   `X-Request-ID`) and stores it in AsyncLocalStorage; every log line and
   every outbox event created during the request carries it.
2. The global `AuthGuard` denies by default: a route must be `@Public()` or
   present a valid access token; `@RequireRole('admin')` adds a role check.
3. `ZodValidationPipe` parses the body, query or params with the same Zod
   schema that generates the OpenAPI document. Unknown fields are rejected by
   name.
4. The service runs, in one transaction when it changes state.
5. `AllExceptionsFilter` turns `AppError`s into `{ error: { code, message,
   details?, request_id } }`; anything unexpected becomes a 500 with no
   internals, logged with its stack.

## Placing and paying for an order

```
POST /orders ──► lock cart row ──► lock inventory rows in variant_id order
                 ──► reserve stock ──► snapshot items and prices ──► empty cart
                 ──► outbox: order.placed  ──────────────────────────► commit
                                    │
       relay ──► notifications: "Recebemos seu pedido"   order-expiry: delayed job at expires_at

POST /orders/{id}/checkout ──► Stripe Checkout session (idempotency key per attempt)
                           ──► extend the reservation past the session's expiry

Stripe ──► POST /payments/webhook ──► verify signature ──► store in stripe_events ──► 200
       relay/queue ──► worker applies it once (processed_events):
                       amount matches? ──► order: pending_payment → paid ──► outbox
                       ──► "Pagamento confirmado" email, low-stock check

expiry job (or the 5-minute sweep) ──► still unpaid and due? ──► expired, stock released
```

Order states: `pending_payment → paid → shipped → delivered`, with
`cancelled` (by the customer before payment, or by an admin) and `expired`
(reservation ran out). Every transition is recorded in
`order_status_history` and emits `order.status_changed`.

## Data model (main tables)

| Table | Holds |
| --- | --- |
| `users`, `refresh_tokens`, `password_reset_tokens` | accounts (citext email, argon2id hash, role); hashed refresh and reset tokens |
| `categories` | tree via `parent_id`; slug |
| `products`, `product_variants`, `product_images` | product (status, generated Portuguese `tsvector`); variant = size × colour with SKU, price, compare-at price; images optionally per colour |
| `inventory` | per variant: `on_hand`, `reserved`, low-stock threshold; CHECKs keep `0 ≤ reserved ≤ on_hand` |
| `carts`, `cart_items` | one cart per user |
| `orders`, `order_items`, `order_status_history` | totals in cents, item snapshots, transitions |
| `payments`, `stripe_events` | Checkout sessions per attempt; every verified webhook, verbatim |
| `outbox_events`, `processed_events` | events awaiting publication; consumer idempotency |

IDs are UUIDv7 (time-ordered, good for indexes and cursors). Timestamps are
`timestamptz`; `updated_at` is set by a trigger.

## Observability

- **Logs:** Pino JSON on stdout; every line has `event`, `service`,
  `correlation_id`. Passwords, tokens, cookies, signatures, emails and names
  are never logged; a test drives a purchase and checks every line.
- **Metrics:** `moda_http_request_duration_seconds` (by route pattern),
  `moda_queue_jobs` (by queue and state; `failed` is the dead-letter queue),
  `moda_outbox_lag_seconds`, `moda_jobs_total` and `moda_job_duration_seconds`
  (worker), plus Node runtime metrics. `METRICS_TOKEN` protects `/metrics`.
- **Probes:** `/health` (process up) and `/ready` (PostgreSQL and Redis
  reachable).

## Testing

- Unit tests (`src/**/*.test.ts`) for logic that needs no database: config,
  slugs, sizes, cursors, cart pricing, order transitions, email templates,
  token signing, Stripe parameters.
- Integration and API tests (`test/**`) run the real Nest application
  against PostgreSQL 18, Redis 8 and Mailpit in containers. Each test file
  gets a database cloned from a migrated template and its own Redis key
  prefix, so files run in parallel. Stripe is replaced by a fake gateway at
  the network boundary only; webhooks are signed with the real algorithm.
- Concurrency is tested directly: parallel orders for the last units never
  oversell, and orders locking the same variants in opposite order never
  deadlock. Security paths have their own tests: a refresh token presented a
  second time revokes every session of its user, and rate limits ignore a
  spoofed `X-Forwarded-For` unless the proxy is trusted.
