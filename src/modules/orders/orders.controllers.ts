import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { IdempotencyInterceptor } from '../../common/idempotency.interceptor.js';
import { ZodValidationPipe } from '../../common/zod.pipe.js';
import { CurrentUser, RequireRole } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import { adminTargets, type OrderStatus, orderStatuses } from './order-status.js';
import { OrdersService, orderErrors } from './orders.service.js';

const orderId = {
  transform: (value: unknown) => {
    if (!z.uuid().safeParse(value).success) throw orderErrors.notFound();
    return value as string;
  },
};
const pageSchema = z.strictObject({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const adminListSchema = pageSchema.extend({
  status: z.enum(orderStatuses).optional(),
  userId: z.uuid('must be a user ID').optional(),
});
const setStatusSchema = z.strictObject({
  status: z.enum(
    adminTargets as [OrderStatus, ...OrderStatus[]],
    'must be one of shipped, delivered, cancelled',
  ),
  reason: z.string().trim().max(200).optional(),
});

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** Places an order for the cart. Send an Idempotency-Key to make retries safe. */
  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  async place(@CurrentUser() user: Principal, @Res({ passthrough: true }) res: Response) {
    const order = await this.orders.place(user.userId);
    res.setHeader('Location', `/api/v1/orders/${order.id}`);
    return order;
  }

  @Get()
  list(
    @CurrentUser() user: Principal,
    @Query(new ZodValidationPipe(pageSchema)) q: z.infer<typeof pageSchema>,
  ) {
    return this.orders.list({ userId: user.userId }, q.cursor, q.limit);
  }

  @Get(':id')
  get(@CurrentUser() user: Principal, @Param('id', orderId) id: string) {
    return this.orders.get(user.userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: Principal, @Param('id', orderId) id: string) {
    return this.orders.cancel(user.userId, id);
  }
}

@RequireRole('admin')
@Controller('admin/orders')
export class OrdersAdminController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Query(new ZodValidationPipe(adminListSchema)) q: z.infer<typeof adminListSchema>) {
    return this.orders.list({ userId: q.userId, status: q.status }, q.cursor, q.limit);
  }

  @Get(':id')
  get(@Param('id', orderId) id: string) {
    return this.orders.get(null, id);
  }

  @Patch(':id/status')
  setStatus(
    @Param('id', orderId) id: string,
    @Body(new ZodValidationPipe(setStatusSchema)) body: z.infer<typeof setStatusSchema>,
  ) {
    return this.orders.adminSetStatus(id, body.status, body.reason || 'set by admin');
  }
}
