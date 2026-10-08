import { Module } from '@nestjs/common';
import { InventoryService } from '../inventory/inventory.service.js';
import { CatalogAdminController, CatalogController } from './catalog.controllers.js';
import { CategoriesService } from './categories.service.js';
import { ProductsService } from './products.service.js';

@Module({
  controllers: [CatalogController, CatalogAdminController],
  providers: [CategoriesService, ProductsService, InventoryService],
  exports: [InventoryService],
})
export class CatalogModule {}
