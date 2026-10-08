import type { Email } from '../../platform/mailer.js';

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const time = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});

export const brl = (cents: number) => money.format(cents / 100).replace(/ /g, ' ');
const shortId = (id: string) => `#${id.slice(-8).toUpperCase()}`;

interface OrderLine {
  productName: string;
  size: string;
  color: string;
  quantity: number;
  lineTotalCents: number;
}

interface OrderInfo {
  id: string;
  totalCents: number;
  shippingCents: number;
  expiresAt: Date | null;
  items: OrderLine[];
}

const lines = (o: OrderInfo) =>
  o.items
    .map((i) => `- ${i.quantity}x ${i.productName} (${i.size}, ${i.color}): ${brl(i.lineTotalCents)}`)
    .join('\n');

export const templates = {
  passwordReset: (to: string, name: string, link: string, ttlMinutes: number): Email => ({
    to,
    subject: 'Redefina sua senha da Moda Hub',
    text: `Olá, ${name}!\n\nPara escolher uma nova senha, acesse o link abaixo. Ele vale por ${ttlMinutes} minutos e só pode ser usado uma vez.\n\n${link}\n\nSe você não pediu isso, pode ignorar este e-mail: sua senha continua a mesma.\n`,
  }),

  orderConfirmation: (to: string, name: string, o: OrderInfo, payLink: string): Email => ({
    to,
    subject: `Recebemos seu pedido ${shortId(o.id)}`,
    text: `Olá, ${name}!\n\nSeu pedido ${shortId(o.id)} está reservado${o.expiresAt ? ` até ${time.format(o.expiresAt)}` : ''}.\n\n${lines(o)}\nFrete: ${o.shippingCents ? brl(o.shippingCents) : 'grátis'}\nTotal: ${brl(o.totalCents)}\n\nFinalize o pagamento em: ${payLink}\n`,
  }),

  paymentConfirmed: (to: string, name: string, o: OrderInfo): Email => ({
    to,
    subject: `Pagamento confirmado: pedido ${shortId(o.id)}`,
    text: `Olá, ${name}!\n\nRecebemos o pagamento de ${brl(o.totalCents)} do pedido ${shortId(o.id)}. Avisaremos quando ele for enviado.\n\n${lines(o)}\n`,
  }),

  orderShipped: (to: string, name: string, o: OrderInfo, note: string): Email => ({
    to,
    subject: `Seu pedido ${shortId(o.id)} foi enviado`,
    text: `Olá, ${name}!\n\nSeu pedido ${shortId(o.id)} saiu para entrega.${note && note !== 'set by admin' ? `\n\n${note}` : ''}\n`,
  }),

  orderClosed: (to: string, name: string, o: OrderInfo, status: 'cancelled' | 'expired'): Email => ({
    to,
    subject:
      status === 'expired' ? `Seu pedido ${shortId(o.id)} expirou` : `Pedido ${shortId(o.id)} cancelado`,
    text:
      status === 'expired'
        ? `Olá, ${name}!\n\nO prazo de pagamento do pedido ${shortId(o.id)} terminou e os itens voltaram ao estoque. Se ainda quiser, é só montar o carrinho de novo.\n`
        : `Olá, ${name}!\n\nO pedido ${shortId(o.id)} foi cancelado e nada foi cobrado.\n`,
  }),

  lowStock: (to: string, items: { sku: string; productName: string; available: number }[]): Email => ({
    to,
    subject: `Estoque baixo: ${items.length} ${items.length === 1 ? 'item' : 'itens'}`,
    text: `Os itens abaixo chegaram ao limite de estoque baixo após uma venda:\n\n${items
      .map((i) => `- ${i.sku} (${i.productName}): ${i.available} disponível(is)`)
      .join('\n')}\n`,
  }),
};
