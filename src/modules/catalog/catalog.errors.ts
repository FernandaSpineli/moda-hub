import { AppError, conflict, notFound } from '../../common/app-error.js';

export const catalogErrors = {
  categoryNotFound: () => notFound('CATEGORY_NOT_FOUND', 'Category not found'),
  productNotFound: () => notFound('PRODUCT_NOT_FOUND', 'Product not found'),
  variantNotFound: () => notFound('VARIANT_NOT_FOUND', 'Variant not found'),
  imageNotFound: () => notFound('IMAGE_NOT_FOUND', 'Image not found'),
  slugTaken: () => conflict('SLUG_TAKEN', 'Another item already uses this slug'),
  skuTaken: () => conflict('SKU_TAKEN', 'Another variant already uses this SKU'),
  variantExists: () =>
    conflict('VARIANT_EXISTS', 'This product already has a variant in that size and colour'),
  categoryInUse: () =>
    conflict('CATEGORY_IN_USE', 'Move or delete the subcategories and products of this category first'),
  categoryCycle: () =>
    conflict('CATEGORY_CYCLE', 'A category cannot be moved under itself or its subcategories'),
  productHasOrders: () =>
    conflict('PRODUCT_HAS_ORDERS', 'This product has been ordered and cannot be deleted; archive it instead'),
  parentNotFound: () =>
    new AppError(422, 'VALIDATION_FAILED', 'One or more fields are invalid', [
      { field: 'parentId', message: 'does not exist' },
    ]),
  categoryIdNotFound: () =>
    new AppError(422, 'VALIDATION_FAILED', 'One or more fields are invalid', [
      { field: 'categoryId', message: 'does not exist' },
    ]),
};
