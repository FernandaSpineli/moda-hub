import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from './support/database.js';

let pool: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = new pg.Pool({ connectionString: db.url });
});
afterAll(async () => {
  await pool.end();
  await drop();
});

const UNIQUE = '23505';
const CHECK = '23514';
const FOREIGN_KEY = '23503';
const RESTRICT = '23001';

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
const one = async (sql: string, params: unknown[] = []) => (await q(sql, params)).rows[0];

interface Fixture {
  userId: string;
  categoryId: string;
  productId: string;
  variantId: string;
}

async function seed(): Promise<Fixture> {
  await q('TRUNCATE users, categories CASCADE');
  const user = await one(
    `INSERT INTO users (email, password_hash, name) VALUES ('Ana@Example.com', 'x', 'Ana') RETURNING id`,
  );
  const parent = await one(
    `INSERT INTO categories (name, slug) VALUES ('Feminino', 'feminino') RETURNING id`,
  );
  const cat = await one(
    `INSERT INTO categories (parent_id, name, slug) VALUES ($1, 'Vestidos', 'vestidos') RETURNING id`,
    [parent.id],
  );
  const product = await one(
    `INSERT INTO products (category_id, name, slug, material, status)
     VALUES ($1, 'Vestido Midi Linho', 'vestido-midi-linho', 'Linho e algodão', 'active') RETURNING id`,
    [cat.id],
  );
  const variant = await one(
    `INSERT INTO product_variants (product_id, sku, size, size_rank, color, color_hex, price_cents)
     VALUES ($1, 'VML-M-PRETO', 'M', 30, 'Preto', '#111111', 25990) RETURNING id`,
    [product.id],
  );
  await q('INSERT INTO inventory (variant_id, on_hand) VALUES ($1, 5)', [variant.id]);
  return { userId: user.id, categoryId: cat.id, productId: product.id, variantId: variant.id };
}

let f: Fixture;
beforeEach(async () => {
  f = await seed();
});

describe('constraints', () => {
  it('treats emails case-insensitively', () =>
    expectCode(
      q(`INSERT INTO users (email, password_hash, name) VALUES ('ana@example.COM', 'x', 'Ana')`),
      UNIQUE,
    ));

  it('rejects unknown roles', () =>
    expectCode(
      q(`INSERT INTO users (email, password_hash, name, role) VALUES ('b@x.com', 'x', 'B', 'root')`),
      CHECK,
    ));

  it('rejects malformed slugs', () =>
    expectCode(q(`INSERT INTO categories (name, slug) VALUES ('Saias', 'Saias Longas')`), CHECK));

  it('stops a category from being its own parent', () =>
    expectCode(q('UPDATE categories SET parent_id = id WHERE id = $1', [f.categoryId]), CHECK));

  it('allows one variant per size and colour', () =>
    expectCode(
      q(
        `INSERT INTO product_variants (product_id, sku, size, size_rank, color, color_hex, price_cents)
         VALUES ($1, 'VML-M-PRETO-2', 'M', 30, 'Preto', '#111111', 100)`,
        [f.productId],
      ),
      UNIQUE,
    ));

  it('requires the sale "from" price to be above the price', () =>
    expectCode(
      q('UPDATE product_variants SET compare_at_price_cents = price_cents WHERE id = $1', [f.variantId]),
      CHECK,
    ));

  it('requires lowercase #rrggbb colours', () =>
    expectCode(q(`UPDATE product_variants SET color_hex = 'black' WHERE id = $1`, [f.variantId]), CHECK));

  it('never reserves more than is on hand', () =>
    expectCode(q('UPDATE inventory SET reserved = 6 WHERE variant_id = $1', [f.variantId]), CHECK));

  it('caps cart quantities at 10 per variant', async () => {
    const cart = await one('INSERT INTO carts (user_id) VALUES ($1) RETURNING id', [f.userId]);
    await expectCode(
      q('INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1, $2, 11)', [cart.id, f.variantId]),
      CHECK,
    );
  });

  it('keeps an order total equal to subtotal plus shipping', () =>
    expectCode(
      q(
        `INSERT INTO orders (user_id, currency, subtotal_cents, shipping_cents, total_cents, expires_at)
         VALUES ($1, 'brl', 25990, 1990, 25990, now() + interval '30 minutes')`,
        [f.userId],
      ),
      CHECK,
    ));

  it('requires an expiry while an order awaits payment', () =>
    expectCode(
      q(
        `INSERT INTO orders (user_id, currency, subtotal_cents, shipping_cents, total_cents)
         VALUES ($1, 'brl', 100, 0, 100)`,
        [f.userId],
      ),
      CHECK,
    ));

  it('rejects orders for unknown users', () =>
    expectCode(
      q(
        `INSERT INTO orders (user_id, status, currency, subtotal_cents, shipping_cents, total_cents)
         VALUES (uuidv7(), 'paid', 'brl', 100, 0, 100)`,
      ),
      FOREIGN_KEY,
    ));
});

describe('orders and payments', () => {
  async function order() {
    return one(
      `INSERT INTO orders (user_id, currency, subtotal_cents, shipping_cents, total_cents, expires_at)
       VALUES ($1, 'brl', 51980, 0, 51980, now() + interval '30 minutes') RETURNING id`,
      [f.userId],
    );
  }

  it('snapshots items, computes line totals and protects sold variants', async () => {
    const o = await order();
    const item = await one(
      `INSERT INTO order_items (order_id, variant_id, product_name, sku, size, color, unit_price_cents, quantity)
       VALUES ($1, $2, 'Vestido Midi Linho', 'VML-M-PRETO', 'M', 'Preto', 25990, 2) RETURNING line_total_cents`,
      [o.id, f.variantId],
    );
    expect(Number(item.line_total_cents)).toBe(51980);
    await expectCode(q('DELETE FROM products WHERE id = $1', [f.productId]), RESTRICT);
  });

  it('allows one open checkout and one successful payment per order', async () => {
    const o = await order();
    const insert = (session: string, status: string) =>
      q(
        `INSERT INTO payments (order_id, stripe_checkout_session_id, status, amount_cents, currency, checkout_url, expires_at)
         VALUES ($1, $2, $3, 51980, 'brl', 'https://checkout.stripe.com/x', now() + interval '31 minutes')`,
        [o.id, session, status],
      );
    await insert('cs_1', 'pending');
    await expectCode(insert('cs_2', 'pending'), UNIQUE);
    await q(`UPDATE payments SET status = 'expired' WHERE stripe_checkout_session_id = 'cs_1'`);
    await insert('cs_2', 'succeeded');
    await expectCode(insert('cs_3', 'succeeded'), UNIQUE);
  });

  it('records each Stripe event once', async () => {
    const insert = () =>
      q(
        `INSERT INTO stripe_events (id, type, payload) VALUES ('evt_1', 'checkout.session.completed', '{}') ON CONFLICT DO NOTHING`,
      );
    expect((await insert()).rowCount).toBe(1);
    expect((await insert()).rowCount).toBe(0);
  });
});

describe('search and housekeeping', () => {
  it.each([
    ['algodao', 'accents are ignored'],
    ['vestidos', 'plurals are stemmed'],
    ['LINHO', 'case is ignored'],
  ])('finds the product for "%s" (%s)', async (term) => {
    const row = await one(
      `SELECT count(*)::int AS n FROM products WHERE search @@ plainto_tsquery('portuguese', f_unaccent($1))`,
      [term],
    );
    expect(row.n).toBe(1);
  });

  it('maintains updated_at with a trigger', async () => {
    const before = await one('SELECT updated_at FROM users WHERE id = $1', [f.userId]);
    const after = await one(`UPDATE users SET name = 'Ana Maria' WHERE id = $1 RETURNING updated_at`, [
      f.userId,
    ]);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});
