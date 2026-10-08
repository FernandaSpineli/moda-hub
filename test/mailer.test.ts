import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpMailer } from '../src/platform/mailer.js';

// Keep in sync with docker-compose.yml.
const MAILPIT_IMAGE = 'axllent/mailpit:v1.31.4';

let mailpit: StartedTestContainer;
let api: string;

beforeAll(async () => {
  mailpit = await new GenericContainer(MAILPIT_IMAGE)
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/livez', 8025))
    .start();
  api = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}/api/v1`;
});
afterAll(() => mailpit?.stop());

describe('SmtpMailer', () => {
  it('delivers through a real SMTP server', async () => {
    const mailer = new SmtpMailer(
      `smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`,
      'Moda Hub <nao-responda@modahub.local>',
    );
    await mailer.send({ to: 'ana@example.com', subject: 'Pedido confirmado', text: 'Olá, Ana!\nObrigada.' });
    mailer.close();

    const list = (await (await fetch(`${api}/messages`)).json()) as {
      messages: { ID: string; Subject: string; From: { Address: string }; To: { Address: string }[] }[];
    };
    expect(list.messages).toHaveLength(1);
    const [m] = list.messages;
    expect([m?.Subject, m?.From.Address, m?.To[0]?.Address]).toEqual([
      'Pedido confirmado',
      'nao-responda@modahub.local',
      'ana@example.com',
    ]);
    const full = (await (await fetch(`${api}/message/${m?.ID}`)).json()) as { Text: string };
    expect(full.Text.replace(/\r\n/g, '\n').trim()).toBe('Olá, Ana!\nObrigada.');
  });

  it('fails loudly when the server is unreachable', async () => {
    const mailer = new SmtpMailer('smtp://127.0.0.1:1', 'x@y.z');
    await expect(mailer.send({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow();
  });
});
