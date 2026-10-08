# ADR 005 — Stock reservation at order time, with expiry

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Fashion stock is shallow: often one or two units per size and colour. Two
shoppers buying the last unit must not both succeed, and stock held by an
abandoned order must come back.

## Decisions

**Reserve when the order is placed, not when it is paid.** `inventory` keeps
`on_hand` and `reserved`; available is the difference. Placing an order, in
one transaction, locks the user's cart row, locks the inventory rows of every
variant in the order **sorted by `variant_id`** (so two orders sharing
variants cannot deadlock), checks availability, increments `reserved`, and
snapshots names and prices into `order_items`. CHECK constraints
(`reserved >= 0`, `reserved <= on_hand`) make overselling impossible even if
code were wrong.

**Payment turns the reservation into a sale** (`on_hand` and `reserved` both
drop). Cancellation and expiry release it.

**Expiry.** Each order has `expires_at` (30 minutes by default; extended by
checkout, see ADR 004). Placing it schedules a delayed job for that moment;
when it runs, the order is expired only if it is still unpaid and actually
due, otherwise the job reschedules itself. A sweep every five minutes catches
orders whose job was lost, for example if Redis was flushed.

**The cart is not a reservation.** Adding to the cart checks availability but
holds nothing, so carts left open do not lock stock away.

## Consequences

- A shopper can lose an item between cart and order; the API answers
  `409 INSUFFICIENT_STOCK` with how many are available.
- Row locks serialise orders for the same variant. For this catalogue size
  that is not a bottleneck; a flash sale on one SKU would need a different
  design (a queue per SKU, or a counter in Redis).
