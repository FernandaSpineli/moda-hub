import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod.pipe.js';
import { Public, RequireRole } from '../auth/decorators.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { catalogErrors } from './catalog.errors.js';
import {
  adminListProductsSchema,
  createCategorySchema,
  createImageSchema,
  createProductSchema,
  createVariantSchema,
  type ListProductsQuery,
  listProductsSchema,
  updateCategorySchema,
  updateProductSchema,
  updateVariantSchema,
  uuidParam,
} from './catalog.schemas.js';
import { CategoriesService } from './categories.service.js';
import { ProductsService } from './products.service.js';

/** A path ID that is not a UUID can never match a row: report it as not found. */
class IdPipe extends ZodValidationPipe<typeof uuidParam> {
  constructor(private readonly notFound: () => Error) {
    super(uuidParam);
  }
  override transform(value: unknown): string {
    if (!uuidParam.safeParse(value).success) throw this.notFound();
    return value as string;
  }
}

const productId = new IdPipe(catalogErrors.productNotFound);
const variantId = new IdPipe(catalogErrors.variantNotFound);
const categoryId = new IdPipe(catalogErrors.categoryNotFound);
const imageId = new IdPipe(catalogErrors.imageNotFound);
const setStockSchema = z.strictObject({
  onHand: z.number().int().min(0).max(1_000_000),
  lowStockThreshold: z.number().int().min(0).max(1_000).optional(),
});

@Public()
@Controller()
export class CatalogController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly products: ProductsService,
  ) {}

  @Get('categories')
  async tree() {
    return { data: await this.categories.tree() };
  }

  @Get('products')
  list(@Query(new ZodValidationPipe(listProductsSchema)) query: ListProductsQuery) {
    return this.products.list(query, false);
  }

  @Get('products/:slug')
  product(@Param('slug') slug: string) {
    return this.products.bySlug(slug);
  }
}

@RequireRole('admin')
@Controller('admin')
export class CatalogAdminController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly products: ProductsService,
    private readonly inventory: InventoryService,
  ) {}

  @Post('categories')
  createCategory(
    @Body(new ZodValidationPipe(createCategorySchema)) body: z.infer<typeof createCategorySchema>,
  ) {
    return this.categories.create(body);
  }

  @Patch('categories/:id')
  updateCategory(
    @Param('id', categoryId) id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: z.infer<typeof updateCategorySchema>,
  ) {
    return this.categories.update(id, body);
  }

  @Delete('categories/:id')
  @HttpCode(204)
  deleteCategory(@Param('id', categoryId) id: string): Promise<void> {
    return this.categories.remove(id);
  }

  @Get('products')
  listProducts(@Query(new ZodValidationPipe(adminListProductsSchema)) query: ListProductsQuery) {
    return this.products.list(query, true);
  }

  @Get('products/:id')
  getProduct(@Param('id', productId) id: string) {
    return this.products.byId(id);
  }

  @Post('products')
  createProduct(@Body(new ZodValidationPipe(createProductSchema)) body: z.infer<typeof createProductSchema>) {
    return this.products.create(body);
  }

  @Patch('products/:id')
  updateProduct(
    @Param('id', productId) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: z.infer<typeof updateProductSchema>,
  ) {
    return this.products.update(id, body);
  }

  @Delete('products/:id')
  @HttpCode(204)
  deleteProduct(@Param('id', productId) id: string): Promise<void> {
    return this.products.remove(id);
  }

  @Post('products/:id/variants')
  addVariant(
    @Param('id', productId) id: string,
    @Body(new ZodValidationPipe(createVariantSchema)) body: z.infer<typeof createVariantSchema>,
  ) {
    return this.products.addVariant(id, body);
  }

  @Patch('variants/:id')
  updateVariant(
    @Param('id', variantId) id: string,
    @Body(new ZodValidationPipe(updateVariantSchema)) body: z.infer<typeof updateVariantSchema>,
  ) {
    return this.products.updateVariant(id, body);
  }

  @Post('products/:id/images')
  addImage(
    @Param('id', productId) id: string,
    @Body(new ZodValidationPipe(createImageSchema)) body: z.infer<typeof createImageSchema>,
  ) {
    return this.products.addImage(id, body);
  }

  @Delete('images/:id')
  @HttpCode(204)
  removeImage(@Param('id', imageId) id: string): Promise<void> {
    return this.products.removeImage(id);
  }

  @Get('variants/:id/inventory')
  stock(@Param('id', variantId) id: string) {
    return this.inventory.level(id);
  }

  @Put('variants/:id/inventory')
  setStock(
    @Param('id', variantId) id: string,
    @Body(new ZodValidationPipe(setStockSchema)) body: z.infer<typeof setStockSchema>,
  ) {
    return this.inventory.set(id, body);
  }
}
