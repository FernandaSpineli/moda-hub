import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiZodBody } from '../../common/openapi.js';
import { ZodValidationPipe } from '../../common/zod.pipe.js';
import { CurrentUser } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import { CartService, cartErrors } from './cart.service.js';
import { MAX_QUANTITY_PER_VARIANT } from './pricing.js';

const quantity = z
  .number()
  .int('must be a whole number')
  .min(1, 'must be at least 1')
  .max(MAX_QUANTITY_PER_VARIANT, `must be at most ${MAX_QUANTITY_PER_VARIANT}`);
const addItemSchema = z.strictObject({ variantId: z.uuid('must be a variant ID'), quantity });
const updateItemSchema = z.strictObject({ quantity });

/** A malformed variant ID in the path can never be in the cart. */
const variantParam = {
  transform: (value: unknown) => {
    if (!z.uuid().safeParse(value).success) throw cartErrors.itemNotFound();
    return value as string;
  },
};

@ApiTags('cart')
@ApiBearerAuth()
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(@CurrentUser() user: Principal) {
    return this.cart.get(user.userId);
  }

  @Delete()
  @HttpCode(204)
  clear(@CurrentUser() user: Principal): Promise<void> {
    return this.cart.clear(user.userId);
  }

  @Post('items')
  @ApiZodBody(addItemSchema)
  @HttpCode(200)
  add(
    @CurrentUser() user: Principal,
    @Body(new ZodValidationPipe(addItemSchema)) body: z.infer<typeof addItemSchema>,
  ) {
    return this.cart.add(user.userId, body.variantId, body.quantity);
  }

  @Patch('items/:variantId')
  @ApiZodBody(updateItemSchema)
  update(
    @CurrentUser() user: Principal,
    @Param('variantId', variantParam) variantId: string,
    @Body(new ZodValidationPipe(updateItemSchema)) body: z.infer<typeof updateItemSchema>,
  ) {
    return this.cart.setQuantity(user.userId, variantId, body.quantity);
  }

  @Delete('items/:variantId')
  remove(@CurrentUser() user: Principal, @Param('variantId', variantParam) variantId: string) {
    return this.cart.remove(user.userId, variantId);
  }
}
