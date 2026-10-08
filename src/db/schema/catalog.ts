import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, tsvector, updatedAt } from './types.js';

const slugCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`);

/** A tree: Feminino › Vestidos › Midi. Listing a category includes its descendants. */
export const categories = pgTable(
  'categories',
  {
    id: id(),
    parentId: uuid().references((): AnyPgColumn => categories.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    slug: text().notNull().unique(),
    position: smallint().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    slugCheck('categories_slug_format', t.slug),
    check('categories_not_own_parent', sql`${t.parentId} <> ${t.id}`),
    index('categories_parent_id_idx').on(t.parentId),
  ],
);

export const products = pgTable(
  'products',
  {
    id: id(),
    categoryId: uuid()
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    slug: text().notNull().unique(),
    description: text().notNull().default(''),
    material: text().notNull().default(''),
    careInstructions: text().notNull().default(''),
    status: text({ enum: ['draft', 'active', 'archived'] })
      .notNull()
      .default('draft'),
    // Portuguese stemming ("vestidos" finds "vestido") on accent-free text
    // ("algodao" finds "algodão").
    search: tsvector().generatedAlwaysAs(
      sql`setweight(to_tsvector('portuguese', f_unaccent(name)), 'A') ||
          setweight(to_tsvector('portuguese', f_unaccent(material)), 'B') ||
          setweight(to_tsvector('portuguese', f_unaccent(description)), 'C')`,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    slugCheck('products_slug_format', t.slug),
    check('products_status_check', sql`${t.status} IN ('draft', 'active', 'archived')`),
    check('products_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 200`),
    index('products_category_id_idx').on(t.categoryId),
    index('products_search_idx').using('gin', t.search),
  ],
);

/**
 * The sellable unit: one size in one colour. compare_at_price is the
 * "de R$ 299 por R$ 199" price shown when a variant is on sale.
 */
export const productVariants = pgTable(
  'product_variants',
  {
    id: id(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sku: text().notNull().unique(),
    size: text().notNull(),
    // Sorts sizes the way shoppers expect (PP < P < M < G < GG, 34 < 36 < ...).
    sizeRank: smallint().notNull(),
    color: text().notNull(),
    colorHex: text().notNull(),
    priceCents: bigint({ mode: 'number' }).notNull(),
    compareAtPriceCents: bigint({ mode: 'number' }),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('product_variants_product_size_color_key').on(t.productId, t.size, t.color),
    check('product_variants_sku_format', sql`${t.sku} ~ '^[A-Z0-9][A-Z0-9-]{1,63}$'`),
    check('product_variants_color_hex_format', sql`${t.colorHex} ~ '^#[0-9a-f]{6}$'`),
    check('product_variants_price_positive', sql`${t.priceCents} > 0`),
    check(
      'product_variants_compare_at_above_price',
      sql`${t.compareAtPriceCents} IS NULL OR ${t.compareAtPriceCents} > ${t.priceCents}`,
    ),
    index('product_variants_product_id_idx').on(t.productId),
  ],
);

/** Photos, optionally for one colour: picking "Preto" shows the black photos. */
export const productImages = pgTable(
  'product_images',
  {
    id: id(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    color: text(),
    url: text().notNull(),
    alt: text().notNull(),
    position: smallint().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check('product_images_url_https', sql`${t.url} ~ '^https://'`),
    index('product_images_product_id_idx').on(t.productId, t.position),
  ],
);

/** available = on_hand - reserved; the CHECKs make overselling impossible. */
export const inventory = pgTable(
  'inventory',
  {
    variantId: uuid()
      .primaryKey()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    onHand: integer().notNull().default(0),
    reserved: integer().notNull().default(0),
    lowStockThreshold: integer().notNull().default(3),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('inventory_on_hand_non_negative', sql`${t.onHand} >= 0`),
    check('inventory_reserved_non_negative', sql`${t.reserved} >= 0`),
    check('inventory_reserved_within_on_hand', sql`${t.reserved} <= ${t.onHand}`),
    check('inventory_threshold_non_negative', sql`${t.lowStockThreshold} >= 0`),
  ],
);
