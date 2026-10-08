import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { productVariants } from './catalog.js';
import { createdAt, id, updatedAt } from './types.js';
import { users } from './users.js';

export const carts = pgTable('carts', {
  id: id(),
  userId: uuid()
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const cartItems = pgTable(
  'cart_items',
  {
    cartId: uuid()
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    variantId: uuid()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    quantity: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.cartId, t.variantId] }),
    check('cart_items_quantity_range', sql`${t.quantity} BETWEEN 1 AND 10`),
    index('cart_items_variant_id_idx').on(t.variantId),
  ],
);
