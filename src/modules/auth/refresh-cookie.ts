import type { Request, Response } from 'express';

const REFRESH_COOKIE = 'refresh_token';
// Only the auth endpoints ever receive the cookie.
const PATH = '/api/v1/auth';

/**
 * The refresh token lives in an HttpOnly cookie: scripts on the page (and
 * so any XSS) cannot read it, and SameSite=Strict keeps other sites from
 * sending it, which is what protects the cookie-authenticated refresh and
 * logout endpoints from CSRF.
 */
export function setRefreshCookie(res: Response, token: string, maxAgeMs: number, secure: boolean): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: PATH,
    maxAge: maxAgeMs,
  });
}

export function clearRefreshCookie(res: Response, secure: boolean): void {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, sameSite: 'strict', secure, path: PATH });
}

/** Reads the refresh cookie without pulling in a cookie-parsing middleware. */
export function readRefreshCookie(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === REFRESH_COOKIE) return decodeURIComponent(value.join('='));
  }
  return undefined;
}
