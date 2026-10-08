import { inspect } from 'node:util';

const REDACTED = '[REDACTED]';

/**
 * Holds a sensitive value (connection string, API key). It redacts itself
 * when converted to a string, serialised to JSON or inspected by a logger;
 * call reveal() exactly where the raw value is needed.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  get isEmpty(): boolean {
    return this.#value === '';
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
