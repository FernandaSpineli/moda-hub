# ADR 004 — Payments: Stripe Checkout, verified webhooks applied by the worker

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Brazilian shoppers pay by card, Pix or boleto. Card details must never touch
our servers. Boleto and Pix confirm minutes or days later. Webhooks can
arrive late, twice, out of order, or for sessions we have replaced; a
customer can open checkout, give up, and try again.

## Decisions

**Stripe Checkout, hosted.** The API creates a Checkout session from the
stored order: amounts come from the database, never from the client. The
call carries an idempotency key per attempt, so a retried request cannot
create a second session. Sessions live 31 minutes (Stripe's minimum is 30),
and creating one extends the order's reservation past the session's end, so
stock cannot be released while the customer is paying. An open session is
reused instead of creating another; opening checkout again after it expired
retires the old one.

**Webhooks: verify, store, acknowledge, then apply.** The endpoint checks
the `Stripe-Signature` against the raw body, writes the whole event to
`stripe_events` (unique on the event ID, so duplicates are no-ops), records
an outbox event, and answers 200. The worker applies it through the
`stripe-events` queue, once, recorded in `processed_events`. Stripe never
waits on our database locks or email, and a failure while applying is
retried by the queue instead of by Stripe.

**Rules when applying:**

- `checkout.session.completed` with `payment_status=paid` marks the order
  paid; with `unpaid` (boleto, Pix) it waits for
  `async_payment_succeeded` or `async_payment_failed`.
- The amount and currency paid must equal the order's; otherwise nothing is
  fulfilled and the mismatch is logged as an error.
- A payment for an order that is already paid (two sessions both paid) or no
  longer payable (expired or cancelled meanwhile) is **not** lost: the payment
  is marked `requires_refund` and logged for someone to refund.
- A customer cannot cancel an order while its checkout session is open, to
  avoid charging for a cancelled order.

**Optional.** Without `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`,
checkout answers `503 PAYMENTS_UNAVAILABLE` and everything else works.

## Consequences

- Refunds are manual for now; `requires_refund` makes them findable.
- Tests replace Stripe with a fake gateway, but webhooks in tests are signed
  with Stripe's real scheme and go through the real verification.
