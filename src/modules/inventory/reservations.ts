import { sql } from 'drizzle-orm';
import { conflict } from '../../common/app-error.js';
import type { Tx } from '../../platform/database.js';

export interface StockLine {
  variantId: string;
  quantity: number;
}

export interface Shortage {
  variantId: string;
  requested: number;
  available: number;
}

export class InsufficientStockError extends Error {
  constructor(readonly shortages: Shortage[]) {
    super(`insufficient stock for ${shortages.length} variant(s)`);
  }

  toAppError() {
    return conflict('INSUFFICIENT_STOCK', 'Not enough units in stock for some items', this.shortages);
  }
}

/** Sets stock aside for unpaid orders, all or nothing. */
export async function reserve(tx: Tx, lines: StockLine[]): Promise<void> {
  const merged = merge(lines);
  const available = await lock(tx, merged);
  const shortages = merged
    .filter((l) => l.quantity > (available.get(l.variantId) ?? 0))
    .map((l) => ({
      variantId: l.variantId,
      requested: l.quantity,
      available: Math.max(available.get(l.variantId) ?? 0, 0),
    }));
  if (shortages.length > 0) throw new InsufficientStockError(shortages);
  await apply(tx, merged, sql`reserved = i.reserved + u.qty`);
}

/** Turns a reservation into a sale: the units leave on_hand. */
export async function commit(tx: Tx, lines: StockLine[]): Promise<void> {
  const merged = merge(lines);
  await lock(tx, merged);
  await apply(tx, merged, sql`on_hand = i.on_hand - u.qty, reserved = i.reserved - u.qty`);
}

/** Returns reserved units to available stock. */
export async function release(tx: Tx, lines: StockLine[]): Promise<void> {
  const merged = merge(lines);
  await lock(tx, merged);
  await apply(tx, merged, sql`reserved = i.reserved - u.qty`);
}

/**
 * Sums duplicates and sorts by variant ID. Every transaction locks inventory
 * rows in this order, so two orders that share variants cannot deadlock.
 */
function merge(lines: StockLine[]): StockLine[] {
  const sum = new Map<string, number>();
  for (const l of lines) sum.set(l.variantId, (sum.get(l.variantId) ?? 0) + l.quantity);
  return [...sum]
    .map(([variantId, quantity]) => ({ variantId, quantity }))
    .sort((a, b) => a.variantId.localeCompare(b.variantId));
}

async function lock(tx: Tx, lines: StockLine[]): Promise<Map<string, number>> {
  const { rows } = await tx.execute<{ variant_id: string; available: number }>(sql`
    SELECT variant_id, on_hand - reserved AS available FROM inventory
    WHERE variant_id = ANY(${sql.param(lines.map((l) => l.variantId))}::uuid[])
    ORDER BY variant_id
    FOR UPDATE`);
  return new Map(rows.map((r) => [r.variant_id, Number(r.available)]));
}

/** One statement for all lines; the table's CHECKs reject overselling or negatives. */
async function apply(tx: Tx, lines: StockLine[], set: ReturnType<typeof sql>): Promise<void> {
  const { rowCount } = await tx.execute(sql`
    UPDATE inventory i SET ${set}
    FROM unnest(${sql.param(lines.map((l) => l.variantId))}::uuid[], ${sql.param(lines.map((l) => l.quantity))}::int[]) AS u(variant_id, qty)
    WHERE i.variant_id = u.variant_id`);
  if (rowCount !== lines.length) throw new Error(`inventory: updated ${rowCount} of ${lines.length} rows`);
}
