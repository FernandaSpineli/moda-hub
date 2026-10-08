import type {
  CheckoutRequest,
  CheckoutSession,
  PaymentGateway,
} from '../../src/modules/payments/payment-gateway.js';
import { PaymentProviderError } from '../../src/modules/payments/payment-gateway.js';

/** Stands in for Stripe. Like Stripe, it returns the original session for a reused idempotency key. */
export class FakeGateway implements PaymentGateway {
  readonly requests: CheckoutRequest[] = [];
  private readonly byKey = new Map<string, CheckoutSession>();
  failWith?: string;

  async createCheckoutSession(req: CheckoutRequest): Promise<CheckoutSession> {
    this.requests.push(req);
    if (this.failWith) throw new PaymentProviderError(this.failWith);
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) return existing;
    const id = `cs_test_${this.byKey.size + 1}`;
    const session = { id, url: `https://checkout.stripe.test/c/pay/${id}`, expiresAt: req.expiresAt };
    this.byKey.set(req.idempotencyKey, session);
    return session;
  }
}
