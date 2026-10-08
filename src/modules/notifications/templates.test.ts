import { describe, expect, it } from 'vitest';
import { brl, templates } from './templates.js';

const order = {
  id: '01a11699-7a06-7d19-ace9-45b3da7b647b',
  totalCents: 53970,
  shippingCents: 0,
  expiresAt: new Date('2026-10-08T15:30:00Z'),
  items: [
    { productName: 'Vestido Midi Linho', size: 'M', color: 'Preto', quantity: 2, lineTotalCents: 51980 },
  ],
};

describe('email templates', () => {
  it('format money the Brazilian way', () => {
    expect(brl(25990)).toBe('R$ 259,90');
    expect(brl(123456)).toBe('R$ 1.234,56');
  });

  it('confirm an order with its items, total and payment deadline (Brasília time)', () => {
    const email = templates.orderConfirmation('ana@example.com', 'Ana', order, 'http://shop.test/pedidos/x');
    expect(email.subject).toBe('Recebemos seu pedido #DA7B647B');
    expect(email.text).toContain('2x Vestido Midi Linho (M, Preto): R$ 519,80');
    expect(email.text).toContain('Frete: grátis');
    expect(email.text).toContain('Total: R$ 539,70');
    expect(email.text).toContain('08/10/2026, 12:30');
  });

  it('carry the reset link and its lifetime', () => {
    const email = templates.passwordReset(
      'ana@example.com',
      'Ana',
      'http://shop.test/reset-password?token=abc',
      30,
    );
    expect(email.text).toContain('http://shop.test/reset-password?token=abc');
    expect(email.text).toContain('30 minutos');
  });

  it('distinguish expired from cancelled orders', () => {
    expect(templates.orderClosed('a@x', 'Ana', order, 'expired').subject).toMatch(/expirou/);
    expect(templates.orderClosed('a@x', 'Ana', order, 'cancelled').subject).toMatch(/cancelado/);
  });
});
