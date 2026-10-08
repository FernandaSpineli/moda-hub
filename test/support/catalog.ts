import { signUp, type TestApp } from './app.js';

interface VariantSpec {
  sku: string;
  size: string;
  color: string;
  colorHex: string;
  priceCents: number;
  compareAtPriceCents?: number;
  stock: number;
}

/**
 * A small fashion catalogue, built through the admin API:
 *
 *   feminino › vestidos › midi   Vestido Midi Linho   P preto (5), M preto (0), M off-white R$259,90 de R$329,90 (2)
 *   feminino › vestidos          Vestido Longo Floral G estampado (3)
 *   feminino › blusas            Blusa de Algodão     PP branco (10), P branco R$89,90 de R$119,90 (1)
 *   feminino                     Saia Plissada        draft
 *   acessorios                   Bolsa Tiracolo       U café (0)
 *   acessorios                   Lenço de Seda        active, no variants
 */
export async function seedCatalog(t: TestApp) {
  const admin = await signUp(t, 'admin');
  const auth = { Authorization: `Bearer ${admin.token}` };
  const post = async (path: string, body: object) => {
    const res = await t.http.post(`/api/v1/admin${path}`).set(auth).send(body);
    if (res.status !== 201) throw new Error(`POST ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const category = (name: string, parentId?: string) => post('/categories', { name, parentId });
  const product = async (name: string, categoryId: string, variants: VariantSpec[], status = 'active') => {
    const p = await post('/products', {
      name,
      categoryId,
      status,
      material: name.includes('Linho') ? 'Linho e algodão' : '',
    });
    const ids: string[] = [];
    for (const { stock, ...v } of variants) {
      const created = await post(`/products/${p.id}/variants`, v);
      ids.push(created.id);
      if (stock > 0) {
        await t.http
          .put(`/api/v1/admin/variants/${created.id}/inventory`)
          .set(auth)
          .send({ onHand: stock })
          .expect(200);
      }
    }
    return { ...p, variantIds: ids };
  };

  const feminino = await category('Feminino');
  const vestidos = await category('Vestidos', feminino.id);
  const midi = await category('Midi', vestidos.id);
  const blusas = await category('Blusas', feminino.id);
  const acessorios = await category('Acessórios');

  const vestidoMidi = await product('Vestido Midi Linho', midi.id, [
    { sku: 'VML-P-PRETO', size: 'P', color: 'Preto', colorHex: '#111111', priceCents: 25990, stock: 5 },
    { sku: 'VML-M-PRETO', size: 'M', color: 'Preto', colorHex: '#111111', priceCents: 25990, stock: 0 },
    {
      sku: 'VML-M-OFF',
      size: 'M',
      color: 'Off-white',
      colorHex: '#f5f0e6',
      priceCents: 25990,
      compareAtPriceCents: 32990,
      stock: 2,
    },
  ]);
  await post(`/products/${vestidoMidi.id}/images`, {
    url: 'https://cdn.modahub.test/vml-1.jpg',
    alt: 'Vestido midi de linho',
  });
  await post(`/products/${vestidoMidi.id}/images`, {
    url: 'https://cdn.modahub.test/vml-preto.jpg',
    alt: 'Vestido midi de linho preto',
    color: 'Preto',
    position: 1,
  });
  const vestidoLongo = await product('Vestido Longo Floral', vestidos.id, [
    { sku: 'VLF-G-EST', size: 'G', color: 'Estampado', colorHex: '#c0392b', priceCents: 31990, stock: 3 },
  ]);
  const blusa = await product('Blusa de Algodão', blusas.id, [
    { sku: 'BA-PP-BR', size: 'PP', color: 'Branco', colorHex: '#ffffff', priceCents: 8990, stock: 10 },
    {
      sku: 'BA-P-BR',
      size: 'P',
      color: 'Branco',
      colorHex: '#ffffff',
      priceCents: 8990,
      compareAtPriceCents: 11990,
      stock: 1,
    },
  ]);
  const saia = await product(
    'Saia Plissada',
    feminino.id,
    [{ sku: 'SP-M-AZ', size: 'M', color: 'Azul', colorHex: '#1f3a93', priceCents: 15990, stock: 4 }],
    'draft',
  );
  const bolsa = await product('Bolsa Tiracolo', acessorios.id, [
    { sku: 'BT-U-CAFE', size: 'U', color: 'Café', colorHex: '#6f4e37', priceCents: 19990, stock: 0 },
  ]);
  const lenco = await product('Lenço de Seda', acessorios.id, []);

  return {
    admin,
    auth,
    categories: { feminino, vestidos, midi, blusas, acessorios },
    products: { vestidoMidi, vestidoLongo, blusa, saia, bolsa, lenco },
  };
}

export type SeededCatalog = Awaited<ReturnType<typeof seedCatalog>>;
