import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Controller, Get, Header, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../modules/auth/decorators.js';

/** Where the API sends shoppers: the shop itself, back from Stripe, or a reset link. */
export const STOREFRONT_PATHS = ['/', 'checkout/success', 'checkout/cancel', 'reset-password'];

const page = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

/**
 * Only the page's own inline script may run: it is allowed by hash, so an
 * injected script would not be. Styles stay inline-friendly because the
 * fabric swatches set their colours through style attributes.
 */
export function contentSecurityPolicy(html: string): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    ([, body]) =>
      `'sha256-${createHash('sha256')
        .update(body as string)
        .digest('base64')}'`,
  );
  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' https: data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const csp = contentSecurityPolicy(page);

/** A demo storefront for the API, served from the same origin as the API. */
@ApiExcludeController()
@Public()
@Controller()
export class StorefrontController {
  @Get(STOREFRONT_PATHS)
  @Header('Cache-Control', 'no-cache')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Referrer-Policy', 'same-origin')
  index(@Res() res: Response): void {
    res.setHeader('Content-Security-Policy', csp);
    res.type('html').send(page);
  }
}
