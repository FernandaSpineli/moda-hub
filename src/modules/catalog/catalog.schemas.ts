import { z } from 'zod';
import { SLUG_PATTERN } from '../../common/slug.js';
import { SIZE_HINT, sizeRank } from './sizes.js';

export const uuidParam = z.uuid('must be an ID');
const slug = z.string().regex(SLUG_PATTERN, 'must be lowercase letters, digits and single dashes').max(120);
const text = (max: number) => z.string().trim().max(max, `must be at most ${max} characters`);
const required = (max: number) => text(max).min(1, 'is required');
const cents = z.number().int('must be whole cents').positive('must be positive').max(100_000_000);

// ---------------------------------------------------------------- categories

export const createCategorySchema = z.strictObject({
  name: required(80),
  slug: slug.optional(),
  parentId: uuidParam.nullable().optional(),
  position: z.number().int().min(0).max(1000).optional(),
});
export const updateCategorySchema = createCategorySchema.partial();

// ---------------------------------------------------------------- products

const productStatus = z.enum(['draft', 'active', 'archived']);

export const createProductSchema = z.strictObject({
  categoryId: uuidParam,
  name: required(200),
  slug: slug.optional(),
  description: text(5000).optional(),
  material: text(200).optional(),
  careInstructions: text(1000).optional(),
  status: productStatus.optional(),
});
export const updateProductSchema = createProductSchema.partial();

export const createVariantSchema = z
  .strictObject({
    sku: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9-]{1,63}$/, 'must be 2-64 letters, digits and dashes'),
    size: z
      .string()
      .trim()
      .toUpperCase()
      .refine((s) => sizeRank(s) !== undefined, `must be ${SIZE_HINT}`),
    color: required(40),
    colorHex: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^#[0-9a-f]{6}$/, 'must be a #rrggbb colour'),
    priceCents: cents,
    compareAtPriceCents: cents.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.compareAtPriceCents == null || v.compareAtPriceCents > v.priceCents, {
    path: ['compareAtPriceCents'],
    message: 'must be higher than priceCents (it is the "was" price)',
  });

export const updateVariantSchema = z.strictObject({
  priceCents: cents.optional(),
  compareAtPriceCents: cents.nullable().optional(),
  active: z.boolean().optional(),
});

export const createImageSchema = z.strictObject({
  url: z.url({ protocol: /^https$/, error: 'must be an https:// URL' }).max(2000),
  alt: required(200),
  color: text(40).min(1).optional(),
  position: z.number().int().min(0).max(100).optional(),
});

// ---------------------------------------------------------------- listing

const csv = z
  .string()
  .transform((s) => [
    ...new Set(
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ])
  .pipe(z.array(z.string().max(40)).max(20));
const queryCents = z.coerce.number().int().min(0).max(100_000_000);

export const productSorts = ['newest', 'price_asc', 'price_desc', 'name', 'relevance'] as const;
export type ProductSort = (typeof productSorts)[number];

const listProductsBase = z.strictObject({
  q: text(100).optional(),
  category: z.string().max(120).optional(),
  size: csv.optional(),
  color: csv.optional(),
  minPrice: queryCents.optional(),
  maxPrice: queryCents.optional(),
  onSale: z.stringbool().optional(),
  inStock: z.stringbool().optional(),
  sort: z.enum(productSorts).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(24),
});

type ListingFields = { minPrice?: number; maxPrice?: number; sort?: string; q?: string };

const withListingRules = <T extends z.ZodType<ListingFields>>(schema: T) =>
  schema
    .refine((v) => v.minPrice === undefined || v.maxPrice === undefined || v.minPrice <= v.maxPrice, {
      path: ['maxPrice'],
      message: 'must not be lower than minPrice',
    })
    .refine((v) => v.sort !== 'relevance' || v.q, {
      path: ['sort'],
      message: 'relevance needs a search query (q)',
    });

export const listProductsSchema = withListingRules(listProductsBase);
/** Admins can also filter by status: drafts and archived products are theirs to see. */
export const adminListProductsSchema = withListingRules(
  listProductsBase.extend({ status: productStatus.optional() }),
);

export type ListProductsQuery = z.infer<typeof adminListProductsSchema>;
