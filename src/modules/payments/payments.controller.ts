import type { RawBodyRequest } from '@nestjs/common';
import { Controller, Headers, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, Public } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import { orderErrors } from '../orders/orders.service.js';
import { PaymentsService } from './payments.service.js';

const orderId = {
  transform: (value: unknown) => {
    if (!z.uuid().safeParse(value).success) throw orderErrors.notFound();
    return value as string;
  },
};

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** 201 with a new Stripe Checkout session, or 200 with the one already open. */
  @Post('orders/:id/checkout')
  async checkout(
    @CurrentUser() user: Principal,
    @Param('id', orderId) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { checkout, created } = await this.payments.startCheckout(user.userId, id);
    res.status(created ? 201 : 200);
    return checkout;
  }

  /** Public: the Stripe signature, not a session, authenticates the caller. */
  @Public()
  @Post('payments/webhook')
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature?: string) {
    const eventId = await this.payments.receive(req.rawBody, signature);
    if (eventId) await this.payments.apply(eventId);
    return { received: true };
  }
}
