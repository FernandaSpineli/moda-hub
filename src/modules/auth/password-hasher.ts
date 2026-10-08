import { Inject, Injectable } from '@nestjs/common';
import argon2, { type HashOptions as Argon2Options } from 'argon2';

export const HASH_OPTIONS = Symbol('HASH_OPTIONS');
/** argon2 cost parameters; production uses the library defaults (64 MiB, t=3). */
export type HashOptions = Omit<Argon2Options, 'type' | 'raw' | 'secret'>;

@Injectable()
export class PasswordHasher {
  // Compared against when an email is unknown, so a failed login takes the
  // same time whether or not the account exists.
  private readonly dummy: Promise<string>;

  constructor(@Inject(HASH_OPTIONS) private readonly options: HashOptions) {
    this.dummy = this.hash('dummy-password-for-timing');
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, { ...this.options, type: argon2.argon2id });
  }

  /** Whether password matches hash. A null hash spends the same time and fails. */
  async verify(hash: string | null, password: string): Promise<boolean> {
    if (hash === null) {
      await argon2.verify(await this.dummy, password);
      return false;
    }
    return argon2.verify(hash, password);
  }
}
