import { Module } from '@nestjs/common';
import { IdempotencyInterceptor } from '../../common/idempotency.interceptor.js';
import { OutboxService } from '../../platform/outbox.js';
import { OrdersAdminController, OrdersController } from './orders.controllers.js';
import { OrdersService } from './orders.service.js';

@Module({
  controllers: [OrdersController, OrdersAdminController],
  providers: [OrdersService, OutboxService, IdempotencyInterceptor],
  exports: [OrdersService],
})
export class OrdersModule {}
