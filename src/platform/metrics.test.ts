import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/config.js';
import { Secret } from '../config/secret.js';
import { metricsAuthorized } from './metrics.js';

describe('metricsAuthorized', () => {
  const open = {} as AppConfig;
  const locked = { metricsToken: new Secret('0123456789abcdef-token') } as AppConfig;

  it('is open when no token is configured', () => {
    expect(metricsAuthorized(open, undefined)).toBe(true);
  });

  it.each([
    [undefined, false],
    ['Bearer wrong', false],
    ['Bearer 0123456789abcdef-tokeX', false],
    ['Bearer 0123456789abcdef-token', true],
    ['0123456789abcdef-token', true],
  ])('%j -> %s', (header, ok) => {
    expect(metricsAuthorized(locked, header)).toBe(ok);
  });
});
