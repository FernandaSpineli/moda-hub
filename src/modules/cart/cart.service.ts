import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { conflict, notFound, validationError } from '../../common/app-error.js';
import { DB, type Db, type DbOrTx, type Tx } from '../../platform/database.js';
import { MAX_QUANTITY_PER_VARIANT, priceLines, type Totals } from './pricing.js';

export interface CartLine {
  variantId: string;
  productName: string;
  productSlug: string;
  sku: string;
  size: string;
  color: string;
  imageUrl: string | null;
  unitPriceCents: number;
  compareAtPriceCents: number | null;
  quantity: number;
  lineTotalCents: number;
  /** Why this line cannot be ordered as it is, if it cannot. */
  issue?: 'unavailable' | 'insufficient_stock';
  /** Set with insufficient_stock, so the client can offer to lower the quantity. */
  availableQuantity?: number;
  purchasable: boolean;
  available: number;
}

export interface Cart extends Totals {
  items: Omit<CartLine, 'purchasable' | 'available'>[];
  itemCount: number;
  currency: 'brl';
  /** False when the cart is empty or any line has an issue. */
  checkoutReady: boolean;
}

export const cartErrors = {
  variantNotFound: () => notFound('VARIANT_NOT_FOUND', 'Variant not found'),
  itemNotFound: () => notFound('CART_ITEM_NOT_FOUND', 'This variant is not in the cart'),
  unavailable: () => conflict('VARIANT_UNAVAILABLE', 'This item is not for sale at the moment'),
  insufficientStock: (requested: number, available: number) =>
    conflict('INSUFFICIENT_STOCK', 'Not enough units in stock', {
      requested,
      available: Math.max(available, 0),
    }),
};

/**
 * The signed-in user's cart. It does not reserve stock: it checks
 * availability when lines change and flags lines that became unavailable
 * since. Stock is reserved, and checked again under lock, when an order is
 * placed.
 */
@Injectable()
export class CartService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext('cart');
  }

  async get(userId: string): Promise<Cart> {
    return summarize(await cartLines(this.db, userId));
  }

  /** Adds units of a variant, on top of any already in the cart. */
  add(userId: string, variantId: string, quantity: number): Promise<Cart> {
    return this.change(userId, variantId, (current) => current + quantity);
  }

  /** Sets the quantity of a line that is already in the cart. */
  setQuantity(userId: string, variantId: string, quantity: number): Promise<Cart> {
    return this.change(userId, variantId, (_current, inCart) => {
      if (!inCart) throw cartErrors.itemNotFound();
      return quantity;
    });
  }

  async remove(userId: string, variantId: string): Promise<Cart> {
    const { rowCount } = await this.db.execute(sql`
      DELETE FROM cart_items ci USING carts c
      WHERE ci.cart_id = c.id AND c.user_id = ${userId} AND ci.variant_id = ${variantId}`);
    if (!rowCount) throw cartErrors.itemNotFound();
    this.logger.info({ variant_id: variantId }, 'cart.item.removed');
    return this.get(userId);
  }

  async clear(userId: string): Promise<void> {
    await clearCart(this.db, userId);
    this.logger.info('cart.cleared');
  }

  /**
   * Runs one quantity change in a transaction that first locks the user's
   * cart row (the upsert), so concurrent requests from the same user are
   * serialised and cannot both pass the stock check.
   */
  private async change(
    userId: string,
    variantId: string,
    next: (current: number, inCart: boolean) => number,
  ): Promise<Cart> {
    const quantity = await this.db.transaction(async (tx) => {
      const cartId = await lockCart(tx, userId);
      const { rows: variants } = await tx.execute<{ purchasable: boolean; available: number }>(sql`
        SELECT v.active AND p.status = 'active' AS purchasable, COALESCE(i.on_hand - i.reserved, 0) AS available
        FROM product_variants v
        JOIN products p ON p.id = v.product_id
        LEFT JOIN inventory i ON i.variant_id = v.id
        WHERE v.id = ${variantId}`);
      const variant = variants[0];
      if (!variant) throw cartErrors.variantNotFound();

      const { rows: items } = await tx.execute<{ quantity: number }>(
        sql`SELECT quantity FROM cart_items WHERE cart_id = ${cartId} AND variant_id = ${variantId}`,
      );
      const quantity = next(items[0]?.quantity ?? 0, items.length > 0);
      if (!variant.purchasable) throw cartErrors.unavailable();
      if (quantity > MAX_QUANTITY_PER_VARIANT) {
        throw validationError([
          { field: 'quantity', message: `the cart holds at most ${MAX_QUANTITY_PER_VARIANT} of each item` },
        ]);
      }
      if (quantity > variant.available) throw cartErrors.insufficientStock(quantity, variant.available);

      await tx.execute(sql`
        INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES (${cartId}, ${variantId}, ${quantity})
        ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity`);
      return quantity;
    });
    this.logger.info({ variant_id: variantId, quantity }, 'cart.item.saved');
    return this.get(userId);
  }
}

/** The user's cart ID, creating the cart if needed, row-locked until the transaction ends. */
async function lockCart(tx: Tx, userId: string): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO carts (user_id) VALUES (${userId})
    ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
    RETURNING id`);
  return (rows[0] as { id: string }).id;
}

/** Locks an existing cart for checkout, so it cannot change while an order is created. */
export async function lockCartForCheckout(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM carts WHERE user_id = ${userId} FOR UPDATE`);
}

/** The cart's lines with current prices and availability, oldest first. */
export async function cartLines(db: DbOrTx, userId: string): Promise<CartLine[]> {
  const { rows } = await db.execute<Record<string, unknown>>(sql`
    SELECT ci.variant_id, p.name AS product_name, p.slug AS product_slug, v.sku, v.size, v.color,
           v.price_cents, v.compare_at_price_cents, ci.quantity,
           v.active AND p.status = 'active' AS purchasable,
           COALESCE(i.on_hand - i.reserved, 0) AS available,
           -- The photo of the chosen colour if there is one, else the first.
           (SELECT url FROM product_images img WHERE img.product_id = p.id
            ORDER BY (img.color = v.color) IS TRUE DESC, img.position LIMIT 1) AS image_url
    FROM carts c
    JOIN cart_items ci ON ci.cart_id = c.id
    JOIN product_variants v ON v.id = ci.variant_id
    JOIN products p ON p.id = v.product_id
    LEFT JOIN inventory i ON i.variant_id = v.id
    WHERE c.user_id = ${userId}
    ORDER BY ci.created_at, ci.variant_id`);
  return rows.map((r) => {
    const unitPriceCents = Number(r.price_cents);
    const quantity = Number(r.quantity);
    return {
      variantId: r.variant_id as string,
      productName: r.product_name as string,
      productSlug: r.product_slug as string,
      sku: r.sku as string,
      size: r.size as string,
      color: r.color as string,
      imageUrl: (r.image_url as string | null) ?? null,
      unitPriceCents,
      compareAtPriceCents: r.compare_at_price_cents == null ? null : Number(r.compare_at_price_cents),
      quantity,
      lineTotalCents: unitPriceCents * quantity,
      purchasable: Boolean(r.purchasable),
      available: Number(r.available),
    };
  });
}

export async function clearCart(db: DbOrTx, userId: string): Promise<void> {
  await db.execute(
    sql`DELETE FROM cart_items ci USING carts c WHERE ci.cart_id = c.id AND c.user_id = ${userId}`,
  );
}

/** Prices the cart and flags lines that cannot be ordered as they are. */
export function summarize(lines: CartLine[]): Cart {
  const items = lines.map(({ purchasable, available, ...line }) => {
    if (!purchasable) return { ...line, issue: 'unavailable' as const };
    if (line.quantity > available) {
      return { ...line, issue: 'insufficient_stock' as const, availableQuantity: Math.max(available, 0) };
    }
    return line;
  });
  return {
    items,
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    currency: 'brl',
    ...priceLines(lines),
    checkoutReady: items.length > 0 && items.every((i) => !('issue' in i)),
  };
}
