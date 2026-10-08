import nodemailer, { type Transporter } from 'nodemailer';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** Sends transactional email. An interface so tests capture mail instead. */
export interface Mailer {
  send(email: Email): Promise<void>;
}

export const MAILER = Symbol('MAILER');

/**
 * SMTP delivery through nodemailer: Mailpit in development, any relay in
 * production. Recipients and subjects come from the database, never from a
 * request, and nodemailer rejects header injection.
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    const url = new URL(smtpUrl);
    this.transport = nodemailer.createTransport({
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'smtps:' ? 465 : 587)),
      secure: url.protocol === 'smtps:',
      auth: url.username
        ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }
        : undefined,
      connectionTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  async send(email: Email): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...email });
  }

  close(): void {
    this.transport.close();
  }
}
