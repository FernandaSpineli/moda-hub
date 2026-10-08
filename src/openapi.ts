import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** The OpenAPI document, built from the controllers and their Zod schemas. */
function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Moda Hub API')
    .setDescription(
      "Women's fashion e-commerce: catalogue with size and colour variants, cart, orders, Stripe payments. " +
        'Prices are integer cents in BRL. Errors are `{ "error": { "code", "message", "details"? } }`.',
    )
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT (EdDSA)' })
    .addCookieAuth('refresh_token', { type: 'apiKey', in: 'cookie', name: 'refresh_token' })
    .build();
  return SwaggerModule.createDocument(app, config);
}

/** Serves the interactive docs at /docs and the document at /docs/openapi.json. */
export function serveOpenApi(app: INestApplication): void {
  SwaggerModule.setup('docs', app, () => buildOpenApi(app), {
    jsonDocumentUrl: 'docs/openapi.json',
    yamlDocumentUrl: 'docs/openapi.yaml',
    ui: true,
  });
}
