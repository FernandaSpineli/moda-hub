import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type CheckoutRequest, PaymentProviderError, StripeGateway } from './payment-gateway.js';

interface Received {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  form: URLSearchParams;
}

/** A local stand-in for api.stripe.com; status 0 drops the connection. */
async function fakeStripe(statuses: number[]) {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        form: new URLSearchParams(body),
      });
      const status = statuses[Math.min(received.length, statuses.length) - 1] as number;
      if (status === 0) return req.socket.destroy();
      res.writeHead(status, { 'Content-Type': 'application/json', 'Request-Id': 'req_fake' });
      res.end(
        status === 200
          ? JSON.stringify({
              id: 'cs_test_abc',
              object: 'checkout.session',
              url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
              expires_at: 1791378000,
            })
          : JSON.stringify({
              error: {
                type: 'invalid_request_error',
                code: 'parameter_invalid_integer',
                message: 'Invalid integer: abc',
              },
            }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    received,
    server,
    gateway: new StripeGateway('sk_test_fake', { host: '127.0.0.1', port, protocol: 'http' }),
  };
}

const request: CheckoutRequest = {
  orderId: 'order-1',
  customerEmail: 'ana@example.com',
  currency: 'brl',
  lines: [{ name: 'Vestido Midi Linho — M / Preto', unitPriceCents: 25990, quantity: 2 }],
  shippingCents: 1990,
  successUrl: 'http://shop.test/checkout/success?order_id=order-1',
  cancelUrl: 'http://shop.test/checkout/cancel?order_id=order-1',
  expiresAt: new Date(1791378000 * 1000),
  idempotencyKey: 'checkout-order-1-1',
};

let server: Server | undefined;
afterEach(() => server?.close());

describe('StripeGateway', () => {
  it('sends the session the order describes', async () => {
    const f = await fakeStripe([200]);
    server = f.server;
    const session = await f.gateway.createCheckoutSession(request);

    expect(session).toEqual({
      id: 'cs_test_abc',
      url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
      expiresAt: new Date(1791378000 * 1000),
    });
    const [r] = f.received;
    expect(r?.method).toBe('POST');
    expect(r?.url).toBe('/v1/checkout/sessions');
    expect(r?.headers.authorization).toBe('Bearer sk_test_fake');
    expect(r?.headers['idempotency-key']).toBe('checkout-order-1-1');
    expect(Object.fromEntries(r?.form ?? [])).toMatchObject({
      mode: 'payment',
      client_reference_id: 'order-1',
      customer_email: 'ana@example.com',
      expires_at: '1791378000',
      'metadata[order_id]': 'order-1',
      'line_items[0][quantity]': '2',
      'line_items[0][price_data][unit_amount]': '25990',
      'line_items[0][price_data][currency]': 'brl',
      'line_items[0][price_data][product_data][name]': 'Vestido Midi Linho — M / Preto',
      'shipping_options[0][shipping_rate_data][fixed_amount][amount]': '1990',
    });
  });

  it('retries a dropped connection with the same idempotency key', async () => {
    const f = await fakeStripe([0, 200]);
    server = f.server;
    await f.gateway.createCheckoutSession(request);
    expect(f.received).toHaveLength(2);
    expect(f.received[0]?.headers['idempotency-key']).toBe(f.received[1]?.headers['idempotency-key']);
  });

  it('describes Stripe errors for the logs without the key', async () => {
    const f = await fakeStripe([400]);
    server = f.server;
    const err = await f.gateway.createCheckoutSession(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentProviderError);
    const message = (err as Error).message;
    for (const part of ['invalid_request_error', 'parameter_invalid_integer', 'status=400', 'req_fake']) {
      expect(message).toContain(part);
    }
    expect(message).not.toContain('sk_test_fake');
  });
});
