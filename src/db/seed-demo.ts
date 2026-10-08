import { sql } from 'drizzle-orm';
import type { PinoLogger } from 'nestjs-pino';
import type { Logger } from 'pino';
import {
  createCategorySchema,
  createProductSchema,
  createVariantSchema,
} from '../modules/catalog/catalog.schemas.js';
import { CategoriesService } from '../modules/catalog/categories.service.js';
import { ProductsService } from '../modules/catalog/products.service.js';
import { InventoryService } from '../modules/inventory/inventory.service.js';
import type { Db } from '../platform/database.js';

type Colour = readonly [name: string, hex: string];
interface DemoProduct {
  category: string;
  name: string;
  description: string;
  material: string;
  careInstructions: string;
  sizes: readonly string[];
  colours: readonly Colour[];
  priceCents: number;
  /** The "de" price: the product is on sale. */
  compareAtPriceCents?: number;
  /** Units per variant; a few variants sell out to show that state. */
  stock: number;
}

const CATEGORIES: readonly (readonly [name: string, parent?: string])[] = [
  ['Vestidos'],
  ['Midi', 'Vestidos'],
  ['Longos', 'Vestidos'],
  ['Blusas e camisas'],
  ['Calças e saias'],
  ['Alfaiataria'],
  ['Acessórios'],
];

const LINHO = 'Lavar à mão em água fria. Não usar alvejante. Passar do avesso em temperatura média.';
const MALHA = 'Lavar na máquina em ciclo delicado. Secar à sombra. Não torcer.';
const SEDA = 'Lavagem a seco. Passar em temperatura baixa, sem vapor.';

const PRODUCTS: readonly DemoProduct[] = [
  {
    category: 'Midi',
    name: 'Vestido Midi Linho Aurora',
    description: 'Decote quadrado, alças largas e saia evasê com fenda lateral. Forro em algodão.',
    material: 'Linho e algodão',
    careInstructions: LINHO,
    sizes: ['PP', 'P', 'M', 'G', 'GG'],
    colours: [
      ['Off-white', '#efe8da'],
      ['Terra', '#a0583c'],
      ['Oliva', '#6b6b3a'],
    ],
    priceCents: 32990,
    stock: 6,
  },
  {
    category: 'Midi',
    name: 'Vestido Midi Envelope Cetim',
    description: 'Transpassado com faixa na cintura e manga bufante curta. Cai bem do dia para a noite.',
    material: 'Cetim de viscose',
    careInstructions: SEDA,
    sizes: ['P', 'M', 'G'],
    colours: [
      ['Vinho', '#5e1f2c'],
      ['Azul-noite', '#1d2a44'],
    ],
    priceCents: 27990,
    compareAtPriceCents: 34990,
    stock: 4,
  },
  {
    category: 'Longos',
    name: 'Vestido Longo Floral Jardim',
    description: 'Estampa exclusiva de flores miúdas, babado na barra e amarração nas costas.',
    material: 'Viscose',
    careInstructions: MALHA,
    sizes: ['P', 'M', 'G', 'GG'],
    colours: [['Floral azul', '#3d5a80']],
    priceCents: 38990,
    stock: 3,
  },
  {
    category: 'Blusas e camisas',
    name: 'Camisa Oversized Popeline',
    description: 'Modelagem ampla, ombro caído e punho com dois botões. Para usar aberta ou por dentro.',
    material: '100% algodão',
    careInstructions: MALHA,
    sizes: ['PP', 'P', 'M', 'G'],
    colours: [
      ['Branco', '#fbfbf8'],
      ['Listrado azul', '#8aa6c1'],
    ],
    priceCents: 18990,
    stock: 8,
  },
  {
    category: 'Blusas e camisas',
    name: 'Blusa Canelada Gola Alta',
    description: 'Malha canelada de toque macio, justa ao corpo, manga longa.',
    material: 'Algodão com elastano',
    careInstructions: MALHA,
    sizes: ['P', 'M', 'G'],
    colours: [
      ['Preto', '#1b1b1b'],
      ['Caramelo', '#b07843'],
      ['Cinza mescla', '#9d9a96'],
    ],
    priceCents: 11990,
    compareAtPriceCents: 14990,
    stock: 10,
  },
  {
    category: 'Calças e saias',
    name: 'Calça Pantalona Alfaiataria',
    description: 'Cintura alta com pregas, pernas amplas e bolsos faca. Comprimento até o chão com salto.',
    material: 'Crepe de poliéster',
    careInstructions: MALHA,
    sizes: ['36', '38', '40', '42', '44'],
    colours: [
      ['Areia', '#cdb99a'],
      ['Preto', '#1b1b1b'],
    ],
    priceCents: 24990,
    stock: 5,
  },
  {
    category: 'Calças e saias',
    name: 'Saia Midi Plissada',
    description: 'Plissado permanente, cós com elástico embutido e movimento leve ao caminhar.',
    material: 'Poliéster acetinado',
    careInstructions: MALHA,
    sizes: ['P', 'M', 'G'],
    colours: [
      ['Verde-musgo', '#4f5d3a'],
      ['Rosa-chá', '#d8a8a0'],
    ],
    priceCents: 19990,
    stock: 4,
  },
  {
    category: 'Calças e saias',
    name: 'Calça Jeans Reta Cintura Alta',
    description: 'Jeans rígido de lavagem clara, corte reto e barra desfiada.',
    material: '100% algodão',
    careInstructions: 'Lavar do avesso em água fria. Não usar secadora.',
    sizes: ['34', '36', '38', '40', '42', '44'],
    colours: [['Azul claro', '#8fb1d1']],
    priceCents: 22990,
    stock: 7,
  },
  {
    category: 'Alfaiataria',
    name: 'Blazer Acinturado Lã Fria',
    description: 'Lapela entalhada, um botão e ombreira leve. Forrado.',
    material: 'Lã fria',
    careInstructions: SEDA,
    sizes: ['P', 'M', 'G', 'GG'],
    colours: [
      ['Cru', '#e7dcc8'],
      ['Grafite', '#3b3d40'],
    ],
    priceCents: 45990,
    compareAtPriceCents: 54990,
    stock: 3,
  },
  {
    category: 'Acessórios',
    name: 'Bolsa Tiracolo Couro Meia-Lua',
    description: 'Couro legítimo, alça regulável e fecho de zíper. Cabe celular, carteira e chaves.',
    material: 'Couro bovino',
    careInstructions: 'Limpar com pano seco. Guardar no saco de proteção.',
    sizes: ['U'],
    colours: [
      ['Café', '#5a3a26'],
      ['Caramelo', '#b07843'],
    ],
    priceCents: 29990,
    stock: 2,
  },
  {
    category: 'Acessórios',
    name: 'Lenço de Seda Estampado',
    description: 'Quadrado de 90 cm com bainha feita à mão. No pescoço, no cabelo ou na bolsa.',
    material: 'Seda pura',
    careInstructions: SEDA,
    sizes: ['U'],
    colours: [['Geométrico', '#c9784f']],
    priceCents: 15990,
    stock: 5,
  },
];

/** The services expect Nest's PinoLogger; outside Nest, forward to a plain pino logger. */
function asPinoLogger(logger: Logger): PinoLogger {
  return { setContext: () => undefined, info: logger.info.bind(logger) } as unknown as PinoLogger;
}

/** SKU from the product's initials, size and colour: VMLA-M-TERRA. */
function sku(product: string, size: string, colour: string): string {
  const initials = product
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .map((w) => w[0])
    .join('');
  const colourCode = colour
    .normalize('NFD')
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')[0]
    ?.slice(0, 6);
  return `${initials}-${size}-${colourCode}`.toUpperCase();
}

/**
 * A demo catalogue for local development and the storefront demo, created
 * through the same services and validation as the admin API. Refuses to run
 * on a database that already has products.
 */
export async function seedDemo(db: Db, logger: Logger): Promise<{ products: number; variants: number }> {
  const existing = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM products`);
  if ((existing.rows[0]?.n ?? 0) > 0)
    throw new Error('the catalogue is not empty; seed-demo only fills a new database');

  const log = asPinoLogger(logger);
  const categories = new CategoriesService(db, log);
  const products = new ProductsService(db, log);
  const inventory = new InventoryService(db, log);

  const categoryIds = new Map<string, string>();
  for (const [position, [name, parent]] of CATEGORIES.entries()) {
    const input = createCategorySchema.parse({
      name,
      position,
      parentId: parent ? categoryIds.get(parent) : undefined,
    });
    categoryIds.set(name, (await categories.create(input)).id);
  }

  let variants = 0;
  for (const [i, p] of PRODUCTS.entries()) {
    const { id } = await products.create(
      createProductSchema.parse({
        categoryId: categoryIds.get(p.category),
        name: p.name,
        description: p.description,
        material: p.material,
        careInstructions: p.careInstructions,
        status: 'active',
      }),
    );
    for (const [c, [colour, hex]] of p.colours.entries()) {
      for (const [s, size] of p.sizes.entries()) {
        const variant = await products.addVariant(
          id,
          createVariantSchema.parse({
            sku: sku(p.name, size, colour),
            size,
            color: colour,
            colorHex: hex,
            priceCents: p.priceCents,
            compareAtPriceCents: p.compareAtPriceCents,
          }),
        );
        // Deterministic gaps: some sizes sell out, so the storefront shows that state.
        const soldOut = (i + c + s) % 7 === 3;
        await inventory.set(variant?.id as string, { onHand: soldOut ? 0 : p.stock + s });
        variants += 1;
      }
    }
  }
  return { products: PRODUCTS.length, variants };
}
