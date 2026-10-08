import { Module } from '@nestjs/common';
import { IdempotencyInterceptor } from '../../common/idempotency.interceptor.js';
import { OrdersAdminController, OrdersController } from './orders.controllers.js';
import { OrdersService } from './orders.service.js';

@Module({
  controllers: [OrdersController, OrdersAdminController],
  providers: [OrdersService, IdempotencyInterceptor],
  exports: [OrdersService],
})
export class OrdersModule {}
