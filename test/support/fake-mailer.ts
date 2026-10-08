import type { Email, Mailer } from '../../src/platform/mailer.js';

/** Captures email instead of sending it; can be told to fail. */
export class FakeMailer implements Mailer {
  readonly sent: Email[] = [];
  /** Fail this many sends before succeeding (Infinity: always fail). */
  failures = 0;

  async send(email: Email): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('SMTP 421 service not available');
    }
    this.sent.push(email);
  }

  to(address: string): Email[] {
    return this.sent.filter((e) => e.to === address);
  }
}
