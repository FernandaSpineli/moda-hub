# ADR 001 — Asynchronous processing: transactional outbox, BullMQ and a worker

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Several things must happen *because* of a state change but should not slow
down, or be able to break, the request that made it: sending email,
applying Stripe webhooks, expiring unpaid orders, warning admins about low
stock. Doing them inline couples the API's latency and availability to SMTP
and to every downstream step; firing them from application code after the
commit can lose them (the process dies between commit and publish) or send
them for changes that rolled back.

## Decisions

**Transactional outbox.** Services record domain events (`order.placed`,
`order.status_changed`, `auth.password_reset_requested`) in `outbox_events`
in the same transaction as the change. An event therefore exists if and only
if the change committed, and it survives a crash right after the commit.

**A relay publishes the outbox to BullMQ.** It claims unpublished rows with
`FOR UPDATE SKIP LOCKED` (several workers can relay without sending an event
twice), fans each event out to one job per consumer, and stamps
`published_at`. Job IDs are derived from the event ID, so if the relay dies
between enqueueing and stamping, the re-publish is deduplicated by BullMQ.

**One job per consumer.** `order.status_changed → paid` becomes a
"payment confirmed" email *and* a low-stock check, on different queues, so a
failing SMTP server never delays stock alerts and each retries on its own.

**Consumers are idempotent.** Queues deliver at least once.
- Database-only effects (applying a Stripe event, expiring an order) are
  naturally idempotent: they lock the row and check its state.
- Side effects outside the database (email) check and record
  `processed_events (consumer, event_id)`. The only window for a duplicate is
  a crash between sending and recording, which is accepted: a rare
  duplicate email beats a lost one.

**Stripe webhooks are recorded, then applied by the worker.** The API
verifies the signature, stores the whole event in `stripe_events` (its
primary key rejects redeliveries) and enqueues it. Stripe gets its 200 at
once; if the database hiccups while applying, the job retries with backoff
instead of answering 500 and waiting for Stripe's own retry schedule.

**Order expiry uses a delayed job per order**, due at `expires_at`. If
checkout extended the reservation meanwhile, the job reschedules itself. A
job scheduler runs a sweep every 5 minutes as a safety net for jobs lost to
a Redis failure. This replaces polling the orders table every minute.

**Retries and a dead-letter queue.** Five attempts with exponential backoff
(1s, 2s, 4s, 8s). Jobs that exhaust them stay in the failed set, are logged
as `job.dead_lettered`, and can be listed and retried by an admin
(`GET /admin/jobs/failed`, `POST /admin/jobs/{queue}/{id}/retry`).

**A separate worker process** (`node dist/worker.js`, same image) runs the
relay and processors. It scales independently of the API, and a slow job
never competes with HTTP requests for the event loop.

**Correlation across processes.** The request ID is stored with each outbox
event and carried in every job; the worker runs each job in its own logging
context, so every log line it produces — including from reused services —
carries `correlation_id`, `queue` and `job_id`.

**The password-reset token is created by the worker**, right before it is
emailed. The outbox and the queue only carry the user ID; the plain token is
never persisted anywhere.

## Why BullMQ (Redis) and not alternatives

- Redis is already part of the stack (idempotency keys), and BullMQ gives
  delayed jobs, retries with backoff, job schedulers and a failed set out of
  the box.
- A PostgreSQL-only queue (`SKIP LOCKED` polling) would remove a dependency
  but means rebuilding delays, backoff and scheduling.
- A broker (RabbitMQ, Kafka) would be more infrastructure than one service
  needs.

## Consequences

- Effects are eventually consistent: an order is "paid" a few hundred
  milliseconds after Stripe's webhook, and clients poll the order (the
  storefront's success page does).
- Losing Redis loses queued jobs but not events: unpublished outbox rows are
  republished, and the sweep catches orders whose expiry job was lost.
- Two processes to run and monitor; both expose the same structured logs.
