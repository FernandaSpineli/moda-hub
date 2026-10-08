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

const [pPreto, mPreto, mOffWhite] = (() => {
  const ids = () => c.products.vestidoMidi.variantIds;
  return [() => ids()[0] as string, () => ids()[1] as string, () => ids()[2] as string];
})();
const blusaPP = () => c.products.blusa.variantIds[0] as string;

async function shopper() {
  const { token } = await signUp(t);
  const auth = { Authorization: `Bearer ${token}` };
  return {
    auth,
    get: () => t.http.get('/api/v1/cart').set(auth),
    add: (variantId: string, quantity: number) =>
      t.http.post('/api/v1/cart/items').set(auth).send({ variantId, quantity }),
    set: (variantId: string, quantity: number) =>
      t.http.patch(`/api/v1/cart/items/${variantId}`).set(auth).send({ quantity }),
    remove: (variantId: string) => t.http.delete(`/api/v1/cart/items/${variantId}`).set(auth),
  };
}

describe('cart', () => {
  it('requires authentication', async () => {
    await t.http.get('/api/v1/cart').expect(401);
    await t.http.post('/api/v1/cart/items').send({}).expect(401);
  });

  it('starts empty', async () => {
    const s = await shopper();
    expect((await s.get().expect(200)).body).toMatchObject({
      items: [],
      itemCount: 0,
      totalCents: 0,
      checkoutReady: false,
    });
  });

  it('prices lines, savings and shipping', async () => {
    const s = await shopper();
    await s.add(mOffWhite(), 1).expect(200);
    const cart = (await s.add(blusaPP(), 1).expect(200)).body;

    expect(cart).toMatchObject({
      itemCount: 2,
      subtotalCents: 25990 + 8990,
      savingsCents: 32990 - 25990,
      shippingCents: 0, // R$ 349,80 qualifies for free shipping
      totalCents: 25990 + 8990,
      freeShippingRemainingCents: 0,
      checkoutReady: true,
    });
    expect(cart.items[0]).toMatchObject({
      productName: 'Vestido Midi Linho',
      size: 'M',
      color: 'Off-white',
      unitPriceCents: 25990,
      compareAtPriceCents: 32990,
      lineTotalCents: 25990,
    });

    const small = (await s.remove(mOffWhite()).expect(200)).body;
    expect(small).toMatchObject({ subtotalCents: 8990, shippingCents: 1990, totalCents: 10980 });
    expect(small.freeShippingRemainingCents).toBe(29900 - 8990);
  });

  it('shows the photo of the chosen colour', async () => {
    const s = await shopper();
    const cart = (await s.add(pPreto(), 1).expect(200)).body;
    expect(cart.items[0].imageUrl).toBe('https://cdn.modahub.test/vml-preto.jpg');
  });

  it('adds to the quantity already in the cart and updates or removes lines', async () => {
    const s = await shopper();
    await s.add(pPreto(), 1).expect(200);
    expect((await s.add(pPreto(), 2).expect(200)).body.items[0].quantity).toBe(3);
    expect((await s.set(pPreto(), 1).expect(200)).body.items[0].quantity).toBe(1);
    await s.remove(pPreto()).expect(200);
    const res = await s.remove(pPreto()).expect(404);
    expect(res.body.error.code).toBe('CART_ITEM_NOT_FOUND');
    await s.set(pPreto(), 1).expect(404);
  });

  it('checks stock, including what is already in the cart', async () => {
    const s = await shopper();
    const res = await s.add(pPreto(), 6).expect(409); // 5 in stock
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: { requested: 6, available: 5 },
    });
    await s.add(pPreto(), 4).expect(200);
    await s.add(pPreto(), 2).expect(409);
    await s.add(mPreto(), 1).expect(409); // sold out
  });

  it('caps each line and validates input', async () => {
    const s = await shopper();
    await t.sql.query('UPDATE inventory SET on_hand = 50 WHERE variant_id = $1', [blusaPP()]);
    await s.add(blusaPP(), 10).expect(200);
    const over = await s.add(blusaPP(), 1).expect(422);
    expect(over.body.error.details[0].field).toBe('quantity');

    for (const body of [
      { variantId: blusaPP(), quantity: 0 },
      { variantId: blusaPP(), quantity: 1.5 },
      { variantId: 'abc', quantity: 1 },
      {},
    ]) {
      await t.http.post('/api/v1/cart/items').set(s.auth).send(body).expect(422);
    }
    const unknown = await s.add('01a11699-7a06-7d19-ace9-45b3da7b647b', 1).expect(404);
    expect(unknown.body.error.code).toBe('VARIANT_NOT_FOUND');
  });

  it('refuses items that are not for sale', async () => {
    const s = await shopper();
    const draftVariant = c.products.saia.variantIds[0] as string;
    const res = await s.add(draftVariant, 1).expect(409);
    expect(res.body.error.code).toBe('VARIANT_UNAVAILABLE');
  });

  it('is private to each user', async () => {
    const ana = await shopper();
    const bia = await shopper();
    await ana.add(pPreto(), 1).expect(200);
    expect((await bia.get()).body.items).toEqual([]);
    await bia.remove(pPreto()).expect(404);
    expect((await ana.get()).body.items).toHaveLength(1);
  });

  it('flags lines that changed after being added, without dropping them', async () => {
    const s = await shopper();
    await s.add(c.products.vestidoLongo.variantIds[0] as string, 3).expect(200);
    await s.add(blusaPP(), 1).expect(200);

    await t.sql.query('UPDATE inventory SET on_hand = 1 WHERE variant_id = $1', [
      c.products.vestidoLongo.variantIds[0],
    ]);
    await t.http
      .patch(`/api/v1/admin/products/${c.products.blusa.id}`)
      .set(c.auth)
      .send({ status: 'archived' })
      .expect(200);

    const cart = (await s.get()).body;
    expect(cart.checkoutReady).toBe(false);
    expect(
      cart.items.map((i: { issue?: string; availableQuantity?: number }) => [i.issue, i.availableQuantity]),
    ).toEqual([
      ['insufficient_stock', 1],
      ['unavailable', undefined],
    ]);
    await t.http
      .patch(`/api/v1/admin/products/${c.products.blusa.id}`)
      .set(c.auth)
      .send({ status: 'active' })
      .expect(200);
    await t.sql.query('UPDATE inventory SET on_hand = 3 WHERE variant_id = $1', [
      c.products.vestidoLongo.variantIds[0],
    ]);
  });

  it('serialises concurrent changes: every accepted add counts, none oversells', async () => {
    const s = await shopper();
    const results = await Promise.all(Array.from({ length: 20 }, () => s.add(pPreto(), 1)));
    const accepted = results.filter((r) => r.status === 200).length;
    const cart = (await s.get()).body;
    expect(accepted).toBe(5);
    expect(cart.items[0].quantity).toBe(5);
  });

  it('can be emptied', async () => {
    const s = await shopper();
    await s.add(pPreto(), 1).expect(200);
    await t.http.delete('/api/v1/cart').set(s.auth).expect(204);
    expect((await s.get()).body.items).toEqual([]);
  });
});
