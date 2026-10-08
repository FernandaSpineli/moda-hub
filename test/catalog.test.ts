import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, startTestApp, type TestApp } from './support/app.js';
import { type SeededCatalog, seedCatalog } from './support/catalog.js';

let t: TestApp;
let c: SeededCatalog;
beforeAll(async () => {
  t = await startTestApp();
  c = await seedCatalog(t);
});
afterAll(() => t.close());

const list = async (query = '') => (await t.http.get(`/api/v1/products${query}`).expect(200)).body;
const slugs = async (query = '') => (await list(query)).data.map((p: { slug: string }) => p.slug);

describe('access control', () => {
  it('reserves catalogue management for admins', async () => {
    const customer = await signUp(t);
    const id = c.products.vestidoMidi.id;
    for (const [method, path] of [
      ['post', '/api/v1/admin/categories'],
      ['patch', `/api/v1/admin/products/${id}`],
      ['delete', `/api/v1/admin/products/${id}`],
      ['get', '/api/v1/admin/products'],
      ['post', `/api/v1/admin/products/${id}/variants`],
      ['put', `/api/v1/admin/variants/${c.products.vestidoMidi.variantIds[0]}/inventory`],
    ] as const) {
      await t.http[method](path).send({}).expect(401);
      await t.http[method](path).set('Authorization', `Bearer ${customer.token}`).send({}).expect(403);
    }
  });
});

describe('categories', () => {
  it('are served as a tree', async () => {
    const { data } = (await t.http.get('/api/v1/categories').expect(200)).body;
    expect(data.map((n: { slug: string }) => n.slug)).toEqual(['acessorios', 'feminino']);
    const feminino = data[1];
    expect(feminino.children.map((n: { slug: string }) => n.slug)).toEqual(['blusas', 'vestidos']);
    expect(feminino.children[1].children[0].slug).toBe('midi');
  });

  it('cannot be moved under themselves or their descendants', async () => {
    const res = await t.http
      .patch(`/api/v1/admin/categories/${c.categories.feminino.id}`)
      .set(c.auth)
      .send({ parentId: c.categories.midi.id })
      .expect(409);
    expect(res.body.error.code).toBe('CATEGORY_CYCLE');
    await t.http
      .patch(`/api/v1/admin/categories/${c.categories.midi.id}`)
      .set(c.auth)
      .send({ parentId: c.categories.midi.id })
      .expect(409);
  });

  it('cannot be deleted while they have subcategories or products', async () => {
    for (const cat of [c.categories.feminino, c.categories.midi]) {
      const res = await t.http.delete(`/api/v1/admin/categories/${cat.id}`).set(c.auth).expect(409);
      expect(res.body.error.code).toBe('CATEGORY_IN_USE');
    }
    const leaf = (
      await t.http.post('/api/v1/admin/categories').set(c.auth).send({ name: 'Macacões' }).expect(201)
    ).body;
    expect(leaf.slug).toBe('macacoes');
    await t.http.delete(`/api/v1/admin/categories/${leaf.id}`).set(c.auth).expect(204);
    await t.http.delete(`/api/v1/admin/categories/${leaf.id}`).set(c.auth).expect(404);
  });

  it('validate parents and slugs', async () => {
    const ghost = '01a11699-7a06-7d19-ace9-45b3da7b647b';
    const res = await t.http
      .post('/api/v1/admin/categories')
      .set(c.auth)
      .send({ name: 'X', parentId: ghost })
      .expect(422);
    expect(res.body.error.details).toEqual([{ field: 'parentId', message: 'does not exist' }]);
    const dup = await t.http
      .post('/api/v1/admin/categories')
      .set(c.auth)
      .send({ name: 'Blusas' })
      .expect(409);
    expect(dup.body.error.code).toBe('SLUG_TAKEN');
  });
});

describe('public listing', () => {
  it('shows only active products with something to sell, newest first', async () => {
    expect(await slugs()).toEqual([
      'bolsa-tiracolo',
      'blusa-de-algodao',
      'vestido-longo-floral',
      'vestido-midi-linho',
    ]);
  });

  it('summarises each product for a product card', async () => {
    const { data } = await list('?category=midi');
    expect(data[0]).toMatchObject({
      slug: 'vestido-midi-linho',
      priceFromCents: 25990,
      onSale: true,
      inStock: true,
      sizes: ['P', 'M'],
      imageUrl: 'https://cdn.modahub.test/vml-1.jpg',
      category: { slug: 'midi', name: 'Midi' },
    });
    expect(data[0].colors).toEqual(
      expect.arrayContaining([
        { name: 'Preto', hex: '#111111' },
        { name: 'Off-white', hex: '#f5f0e6' },
      ]),
    );
    const bolsa = (await list('?category=acessorios')).data[0];
    expect(bolsa).toMatchObject({ slug: 'bolsa-tiracolo', inStock: false, onSale: false });
  });

  it.each([
    ['?category=vestidos', ['vestido-longo-floral', 'vestido-midi-linho']], // includes subcategories
    ['?category=feminino&sort=name', ['blusa-de-algodao', 'vestido-longo-floral', 'vestido-midi-linho']],
    ['?category=nope', []],
    ['?sort=price_asc', ['blusa-de-algodao', 'bolsa-tiracolo', 'vestido-midi-linho', 'vestido-longo-floral']],
    [
      '?sort=price_desc',
      ['vestido-longo-floral', 'vestido-midi-linho', 'bolsa-tiracolo', 'blusa-de-algodao'],
    ],
    ['?minPrice=20000&maxPrice=30000', ['vestido-midi-linho']],
    ['?onSale=true&sort=name', ['blusa-de-algodao', 'vestido-midi-linho']],
    ['?inStock=true&sort=name', ['blusa-de-algodao', 'vestido-longo-floral', 'vestido-midi-linho']],
    ['?size=GG', []],
    ['?size=pp,g&sort=name', ['blusa-de-algodao', 'vestido-longo-floral']],
    ['?color=cafe', ['bolsa-tiracolo']], // accent-insensitive
    ['?color=OFF-WHITE', ['vestido-midi-linho']],
    // Every filter applies to the same variant: the black M is sold out...
    ['?size=M&color=preto&inStock=true', []],
    // ...but the off-white M is not.
    ['?size=M&inStock=true', ['vestido-midi-linho']],
    ['?q=algodao&sort=name', ['blusa-de-algodao', 'vestido-midi-linho']], // name and material, no accents
    ['?q=vestidos', ['vestido-longo-floral', 'vestido-midi-linho']], // stemming
    ['?q=saia', []], // drafts are not searchable
  ])('%s', async (query, expected) => {
    const got = await slugs(query);
    if (query.includes('q=vestidos')) expect(got.sort()).toEqual(expected);
    else expect(got).toEqual(expected);
  });

  it.each([
    ['?sort=popularity', 'sort'],
    ['?sort=relevance', 'sort'],
    ['?minPrice=500&maxPrice=100', 'maxPrice'],
    ['?limit=500', 'limit'],
    ['?onSale=maybe', 'onSale'],
    ['?status=draft', 'status'],
  ])('rejects %s', async (query, field) => {
    const res = await t.http.get(`/api/v1/products${query}`).expect(422);
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
  });
});

describe('cursor pagination', () => {
  it.each(['newest', 'price_asc', 'price_desc', 'name'])(
    'walks every page exactly once (%s)',
    async (sort) => {
      const all = await slugs(`?sort=${sort}`);
      const seen: string[] = [];
      let cursor: string | null = '';
      while (cursor !== null) {
        const page: { data: { slug: string }[]; nextCursor: string | null } = await list(
          `?sort=${sort}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        );
        seen.push(...page.data.map((p) => p.slug));
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(all);
    },
  );

  it('stays correct when products are added between pages', async () => {
    const first = await list('?limit=2');
    const p = (
      await t.http.post('/api/v1/admin/products').set(c.auth).send({
        name: 'Cardigã Tricô',
        categoryId: c.categories.blusas.id,
        status: 'active',
      })
    ).body;
    await t.http
      .post(`/api/v1/admin/products/${p.id}/variants`)
      .set(c.auth)
      .send({ sku: 'CT-M-BEGE', size: 'M', color: 'Bege', colorHex: '#d8c3a5', priceCents: 17990 })
      .expect(201);

    const second = await list(`?limit=10&cursor=${first.nextCursor}`);
    const pages = [...first.data, ...second.data].map((x: { slug: string }) => x.slug);
    expect(new Set(pages).size).toBe(pages.length); // no duplicates
    expect(pages).not.toContain('cardiga-trico'); // newer than the first page: not shown on later pages

    await t.http.patch(`/api/v1/admin/products/${p.id}`).set(c.auth).send({ status: 'archived' }).expect(200);
  });

  it('rejects tampered cursors and cursors from another sort', async () => {
    const { nextCursor } = await list('?limit=1&sort=price_asc');
    for (const query of [`?sort=name&cursor=${nextCursor}`, '?cursor=bm9wZQ']) {
      const res = await t.http.get(`/api/v1/products${query}`).expect(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    }
  });
});

describe('product page', () => {
  it('shows active variants by size order, with sale prices and images', async () => {
    const res = await t.http.get('/api/v1/products/vestido-midi-linho').expect(200);
    const variants = res.body.variants.map((v: { size: string; color: string }) => `${v.size} ${v.color}`);
    expect(variants).toEqual(['P Preto', 'M Off-white', 'M Preto']);
    const offWhite = res.body.variants.find((v: { color: string }) => v.color === 'Off-white');
    expect(offWhite).toMatchObject({
      priceCents: 25990,
      compareAtPriceCents: 32990,
      discountPercent: 21,
      inStock: true,
    });
    expect(res.body.images.map((i: { color: string | null }) => i.color)).toEqual([null, 'Preto']);
    expect(res.body).not.toHaveProperty('search');
  });

  it('hides drafts, products without variants and unknown slugs', async () => {
    for (const slug of ['saia-plissada', 'lenco-de-seda', 'nope', 'Bad%20Slug']) {
      const res = await t.http.get(`/api/v1/products/${slug}`).expect(404);
      expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
    }
  });
});

describe('product management', () => {
  it('derives slugs and validates references', async () => {
    const p = (
      await t.http.post('/api/v1/admin/products').set(c.auth).send({
        name: 'Calça Wide Leg Pérola',
        categoryId: c.categories.feminino.id,
      })
    ).body;
    expect(p).toMatchObject({ slug: 'calca-wide-leg-perola', status: 'draft', variants: [] });

    const ghost = await t.http
      .post('/api/v1/admin/products')
      .set(c.auth)
      .send({ name: 'X', categoryId: '01a11699-7a06-7d19-ace9-45b3da7b647b' })
      .expect(422);
    expect(ghost.body.error.details).toEqual([{ field: 'categoryId', message: 'does not exist' }]);
    const dup = await t.http
      .post('/api/v1/admin/products')
      .set(c.auth)
      .send({ name: 'Blusa de Algodão', categoryId: c.categories.blusas.id })
      .expect(409);
    expect(dup.body.error.code).toBe('SLUG_TAKEN');
  });

  it('validates variants', async () => {
    const path = `/api/v1/admin/products/${c.products.blusa.id}/variants`;
    const base = { sku: 'BA-M-BR', size: 'M', color: 'Branco', colorHex: '#FFFFFF', priceCents: 8990 };

    const sameSlot = await t.http
      .post(path)
      .set(c.auth)
      .send({ ...base, size: 'PP' })
      .expect(409);
    expect(sameSlot.body.error.code).toBe('VARIANT_EXISTS');
    const sameSku = await t.http
      .post(path)
      .set(c.auth)
      .send({ ...base, sku: 'ba-pp-br', color: 'Rosa' })
      .expect(409);
    expect(sameSku.body.error.code).toBe('SKU_TAKEN');

    for (const [body, field] of [
      [{ ...base, size: 'XS' }, 'size'],
      [{ ...base, colorHex: 'white' }, 'colorHex'],
      [{ ...base, compareAtPriceCents: 8990 }, 'compareAtPriceCents'],
      [{ ...base, priceCents: 0 }, 'priceCents'],
    ] as const) {
      const res = await t.http.post(path).set(c.auth).send(body).expect(422);
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
    }
    const created = await t.http.post(path).set(c.auth).send(base).expect(201);
    expect(created.body).toMatchObject({ sku: 'BA-M-BR', colorHex: '#ffffff', sizeRank: 30 });
  });

  it('only accepts https images', async () => {
    await t.http
      .post(`/api/v1/admin/products/${c.products.blusa.id}/images`)
      .set(c.auth)
      .send({ url: 'http://cdn.example/x.jpg', alt: 'x' })
      .expect(422);
  });

  it('refuses to delete products that were ordered', async () => {
    const [variantId] = c.products.vestidoLongo.variantIds;
    await t.sql.query(
      `WITH o AS (
         INSERT INTO orders (user_id, status, currency, subtotal_cents, shipping_cents, total_cents)
         VALUES ($1, 'paid', 'brl', 31990, 0, 31990) RETURNING id)
       INSERT INTO order_items (order_id, variant_id, product_name, sku, size, color, unit_price_cents, quantity)
       SELECT id, $2, 'Vestido Longo Floral', 'VLF-G-EST', 'G', 'Estampado', 31990, 1 FROM o`,
      [c.admin.userId, variantId],
    );
    const res = await t.http
      .delete(`/api/v1/admin/products/${c.products.vestidoLongo.id}`)
      .set(c.auth)
      .expect(409);
    expect(res.body.error.code).toBe('PRODUCT_HAS_ORDERS');
    await t.http.delete(`/api/v1/admin/products/${c.products.lenco.id}`).set(c.auth).expect(204);
  });
});

describe('inventory', () => {
  it('tracks stock and protects reserved units', async () => {
    const [variantId] = c.products.blusa.variantIds;
    const path = `/api/v1/admin/variants/${variantId}/inventory`;
    expect((await t.http.get(path).set(c.auth).expect(200)).body).toMatchObject({
      onHand: 10,
      reserved: 0,
      available: 10,
    });

    await t.sql.query('UPDATE inventory SET reserved = 4 WHERE variant_id = $1', [variantId]);
    const below = await t.http.put(path).set(c.auth).send({ onHand: 3 }).expect(409);
    expect(below.body.error.code).toBe('BELOW_RESERVED');
    const ok = await t.http.put(path).set(c.auth).send({ onHand: 12, lowStockThreshold: 2 }).expect(200);
    expect(ok.body).toMatchObject({ onHand: 12, reserved: 4, available: 8, lowStockThreshold: 2 });

    await t.http.put(path).set(c.auth).send({ onHand: -1 }).expect(422);
    await t.http
      .get('/api/v1/admin/variants/01a11699-7a06-7d19-ace9-45b3da7b647b/inventory')
      .set(c.auth)
      .expect(404);
    await t.http.get('/api/v1/admin/variants/123/inventory').set(c.auth).expect(404);
  });
});
