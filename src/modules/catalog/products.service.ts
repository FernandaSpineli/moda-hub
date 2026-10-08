import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, type SQL, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { z } from 'zod';
import { decodeCursor, encodeCursor, type Page } from '../../common/cursor.js';
import { slugify } from '../../common/slug.js';
import { productImages, products, productVariants } from '../../db/schema/index.js';
import { DB, type Db } from '../../platform/database.js';
import { isForeignKeyViolation, isRestrictViolation, isUniqueViolation } from '../../platform/db-errors.js';
import { catalogErrors } from './catalog.errors.js';
import type {
  createImageSchema,
  createProductSchema,
  createVariantSchema,
  ListProductsQuery,
  ProductSort,
  updateProductSchema,
  updateVariantSchema,
} from './catalog.schemas.js';
import { sizeRank } from './sizes.js';

export interface ProductSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  category: { id: string; slug: string; name: string };
  /** Cheapest active variant; null only in admin listings without variants. */
  priceFromCents: number | null;
  onSale: boolean;
  inStock: boolean;
  colors: { name: string; hex: string }[];
  sizes: string[];
  imageUrl: string | null;
  createdAt: Date;
}

const discountPercent = (price: number, compareAt: number | null) =>
  compareAt ? Math.round(((compareAt - price) / compareAt) * 100) : null;

/** The expression a listing is ordered by, and in which direction. */
function sortKey(sort: ProductSort, q: string | undefined): { key: SQL; desc: boolean } {
  switch (sort) {
    case 'newest':
      return { key: sql`p.created_at`, desc: true };
    case 'price_asc':
      return { key: sql`COALESCE(agg.min_price, 0)`, desc: false };
    case 'price_desc':
      return { key: sql`COALESCE(agg.min_price, 0)`, desc: true };
    case 'name':
      return { key: sql`p.name COLLATE "und-x-icu"`, desc: false };
    case 'relevance':
      // float8 so the rank survives the round trip through a cursor exactly
      // (ts_rank returns float4).
      return {
        key: sql`ts_rank(p.search, plainto_tsquery('portuguese', f_unaccent(${q ?? ''})))::float8`,
        desc: true,
      };
  }
}

@Injectable()
export class ProductsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext('catalog');
  }

  /**
   * One page of products. The public listing only shows active products
   * with at least one active variant; admins see everything. Variant
   * filters (size, colour, price, sale, stock) must all hold for the same
   * variant: "M, black, in stock" means a black M that is in stock.
   */
  async list(query: ListProductsQuery, admin: boolean): Promise<Page<ProductSummary>> {
    const sort: ProductSort = query.sort ?? (query.q ? 'relevance' : 'newest');
    const where: SQL[] = [];

    if (admin) {
      if (query.status) where.push(sql`p.status = ${query.status}`);
    } else {
      where.push(sql`p.status = 'active'`, sql`agg.min_price IS NOT NULL`);
    }
    if (query.q) where.push(sql`p.search @@ plainto_tsquery('portuguese', f_unaccent(${query.q}))`);
    if (query.category) {
      // The category and all its descendants.
      where.push(sql`p.category_id IN (
        WITH RECURSIVE subtree AS (
          SELECT id FROM categories WHERE slug = ${query.category}
          UNION ALL
          SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id
        ) SELECT id FROM subtree)`);
    }

    // Arrays go in as one parameter (sql.param); a bare array would be
    // spread into a list of parameters.
    const variant: SQL[] = [sql`v.product_id = p.id`, sql`v.active`];
    if (query.size?.length)
      variant.push(sql`v.size = ANY(${sql.param(query.size.map((s) => s.toUpperCase()))}::text[])`);
    if (query.color?.length) {
      variant.push(
        sql`lower(f_unaccent(v.color)) IN (SELECT lower(f_unaccent(c)) FROM unnest(${sql.param(query.color)}::text[]) c)`,
      );
    }
    if (query.minPrice !== undefined) variant.push(sql`v.price_cents >= ${query.minPrice}`);
    if (query.maxPrice !== undefined) variant.push(sql`v.price_cents <= ${query.maxPrice}`);
    if (query.onSale) variant.push(sql`v.compare_at_price_cents IS NOT NULL`);
    if (query.inStock) variant.push(sql`COALESCE(i.on_hand - i.reserved, 0) > 0`);
    if (variant.length > 2) {
      where.push(sql`EXISTS (
        SELECT 1 FROM product_variants v LEFT JOIN inventory i ON i.variant_id = v.id
        WHERE ${sql.join(variant, sql` AND `)})`);
    }

    const { key, desc } = sortKey(sort, query.q);
    if (query.cursor) {
      const c = decodeCursor(query.cursor, sort);
      const op = desc ? sql`<` : sql`>`;
      const value = sort === 'newest' ? sql`${c.value}::timestamptz` : sql`${c.value}`;
      where.push(sql`(${key} ${op} ${value} OR (${key} = ${value} AND p.id ${op} ${c.id}::uuid))`);
    }
    const dir = desc ? sql`DESC` : sql`ASC`;

    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT p.id, p.slug, p.name, p.status, p.created_at,
             c.id AS category_id, c.slug AS category_slug, c.name AS category_name,
             agg.min_price, agg.on_sale, agg.in_stock, agg.colors, agg.sizes, img.url AS image_url,
             ${key} AS sort_key
      FROM products p
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN LATERAL (
        SELECT min(v.price_cents) AS min_price,
               COALESCE(bool_or(v.compare_at_price_cents IS NOT NULL), false) AS on_sale,
               COALESCE(bool_or(COALESCE(i.on_hand - i.reserved, 0) > 0), false) AS in_stock,
               COALESCE(json_agg(DISTINCT jsonb_build_object('name', v.color, 'hex', v.color_hex)), '[]') AS colors,
               ARRAY(SELECT DISTINCT ON (v2.size_rank) v2.size FROM product_variants v2
                     WHERE v2.product_id = p.id AND v2.active ORDER BY v2.size_rank) AS sizes
        FROM product_variants v LEFT JOIN inventory i ON i.variant_id = v.id
        WHERE v.product_id = p.id AND v.active
      ) agg ON true
      LEFT JOIN LATERAL (
        SELECT url FROM product_images WHERE product_id = p.id ORDER BY position, created_at LIMIT 1
      ) img ON true
      ${where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
      ORDER BY ${key} ${dir}, p.id ${dir}
      LIMIT ${query.limit + 1}`);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toSummary),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor<ProductSort>({ sort, value: cursorValue(sort, last.sort_key), id: String(last.id) })
          : null,
    };
  }

  /** The public product page: an active product with its active variants. */
  async bySlug(slug: string) {
    const [product] = await this.db.query.products.findMany({
      where: and(eq(products.slug, slug), eq(products.status, 'active')),
      limit: 1,
    });
    if (!product) throw catalogErrors.productNotFound();
    const detail = await this.detail(product, true);
    if (detail.variants.length === 0) throw catalogErrors.productNotFound();
    return detail;
  }

  /** Any product, with every variant: the admin view. */
  async byId(id: string) {
    const product = await this.db.query.products.findFirst({ where: eq(products.id, id) });
    if (!product) throw catalogErrors.productNotFound();
    return this.detail(product, false);
  }

  async create(input: z.infer<typeof createProductSchema>) {
    const [created] = await this.write(() =>
      this.db
        .insert(products)
        .values({ ...input, slug: input.slug ?? slugify(input.name) })
        .returning({ id: products.id }),
    );
    this.logger.info({ product_id: created?.id }, 'catalog.product.created');
    return this.byId(created?.id as string);
  }

  async update(id: string, input: z.infer<typeof updateProductSchema>) {
    const updated = await this.write(() =>
      this.db.update(products).set(input).where(eq(products.id, id)).returning({ id: products.id }),
    );
    if (updated.length === 0) throw catalogErrors.productNotFound();
    this.logger.info({ product_id: id, status: input.status }, 'catalog.product.updated');
    return this.byId(id);
  }

  /** Deletes a product that was never ordered; sold ones must be archived. */
  async remove(id: string): Promise<void> {
    const deleted = await this.write(() =>
      this.db.delete(products).where(eq(products.id, id)).returning({ id: products.id }),
    );
    if (deleted.length === 0) throw catalogErrors.productNotFound();
    this.logger.info({ product_id: id }, 'catalog.product.deleted');
  }

  async addVariant(productId: string, input: z.infer<typeof createVariantSchema>) {
    const [variant] = await this.write(() =>
      this.db
        .insert(productVariants)
        .values({ ...input, productId, sizeRank: sizeRank(input.size) as number })
        .returning(),
    );
    this.logger.info(
      { product_id: productId, variant_id: variant?.id, sku: variant?.sku },
      'catalog.variant.created',
    );
    return variant;
  }

  async updateVariant(id: string, input: z.infer<typeof updateVariantSchema>) {
    const [variant] = await this.write(() =>
      this.db.update(productVariants).set(input).where(eq(productVariants.id, id)).returning(),
    );
    if (!variant) throw catalogErrors.variantNotFound();
    this.logger.info({ variant_id: id }, 'catalog.variant.updated');
    return variant;
  }

  async addImage(productId: string, input: z.infer<typeof createImageSchema>) {
    const [image] = await this.write(() =>
      this.db
        .insert(productImages)
        .values({ ...input, productId })
        .returning(),
    );
    return image;
  }

  async removeImage(id: string): Promise<void> {
    const deleted = await this.db.delete(productImages).where(eq(productImages.id, id)).returning();
    if (deleted.length === 0) throw catalogErrors.imageNotFound();
  }

  private async detail(product: typeof products.$inferSelect, publicView: boolean) {
    const [category, variants, images] = await Promise.all([
      this.db.query.categories.findFirst({ where: (c, { eq: is }) => is(c.id, product.categoryId) }),
      this.db.execute<Record<string, unknown>>(sql`
        SELECT v.*, COALESCE(i.on_hand - i.reserved, 0) > 0 AS in_stock
        FROM product_variants v LEFT JOIN inventory i ON i.variant_id = v.id
        WHERE v.product_id = ${product.id} ${publicView ? sql`AND v.active` : sql``}
        ORDER BY v.size_rank, v.color`),
      this.db
        .select()
        .from(productImages)
        .where(eq(productImages.productId, product.id))
        .orderBy(asc(productImages.position), asc(productImages.createdAt)),
    ]);
    const { search: _search, categoryId: _categoryId, ...fields } = product;
    return {
      ...fields,
      category: category && { id: category.id, slug: category.slug, name: category.name },
      variants: variants.rows.map((v) => {
        const price = Number(v.price_cents);
        const compareAt = v.compare_at_price_cents == null ? null : Number(v.compare_at_price_cents);
        return {
          id: v.id as string,
          sku: v.sku as string,
          size: v.size as string,
          color: v.color as string,
          colorHex: v.color_hex as string,
          priceCents: price,
          compareAtPriceCents: compareAt,
          discountPercent: discountPercent(price, compareAt),
          active: v.active as boolean,
          inStock: v.in_stock as boolean,
        };
      }),
      images: images.map(({ id, url, alt, color, position }) => ({ id, url, alt, color, position })),
    };
  }

  private async write<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (isUniqueViolation(err, 'products_slug_unique')) throw catalogErrors.slugTaken();
      if (isUniqueViolation(err, 'product_variants_sku_unique')) throw catalogErrors.skuTaken();
      if (isUniqueViolation(err, 'product_variants_product_size_color_key'))
        throw catalogErrors.variantExists();
      if (isForeignKeyViolation(err, 'products_category_id_categories_id_fk'))
        throw catalogErrors.categoryIdNotFound();
      if (isForeignKeyViolation(err)) throw catalogErrors.productNotFound();
      if (isRestrictViolation(err)) throw catalogErrors.productHasOrders();
      throw err;
    }
  }
}

function cursorValue(sort: ProductSort, key: unknown): string | number {
  if (sort === 'newest') return new Date(key as string).toISOString();
  if (sort === 'name') return String(key);
  return Number(key);
}

function toSummary(r: Record<string, unknown>): ProductSummary {
  return {
    id: r.id as string,
    slug: r.slug as string,
    name: r.name as string,
    status: r.status as string,
    category: {
      id: r.category_id as string,
      slug: r.category_slug as string,
      name: r.category_name as string,
    },
    priceFromCents: r.min_price == null ? null : Number(r.min_price),
    onSale: Boolean(r.on_sale),
    inStock: Boolean(r.in_stock),
    colors: r.colors as { name: string; hex: string }[],
    sizes: (r.sizes as string[]) ?? [],
    imageUrl: (r.image_url as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
  };
}
