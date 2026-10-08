import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { readRefreshCookie } from './refresh-cookie.js';

const req = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as Request;

describe('readRefreshCookie', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['theme=dark', undefined],
    ['refresh_token=abc', 'abc'],
    ['theme=dark; refresh_token=a%2Bb=; other=1', 'a+b='],
    ['xrefresh_token=nope', undefined],
  ])('%j -> %j', (header, expected) => {
    expect(readRefreshCookie(req(header))).toBe(expected);
  });
});
