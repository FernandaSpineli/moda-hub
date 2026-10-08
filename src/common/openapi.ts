import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

type JsonSchema = Record<string, unknown> & { properties?: Record<string, JsonSchema>; required?: string[] };

/**
 * The OpenAPI schema of what a Zod schema accepts as input. The same schema
 * validates the request, so the documentation cannot drift from it.
 */
export function openApiSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    target: 'openapi-3.0',
    unrepresentable: 'any',
  }) as JsonSchema;
  return json;
}

/** Documents a JSON request body from its Zod schema. */
export const ApiZodBody = (schema: z.ZodType) =>
  // biome-ignore lint/suspicious/noExplicitAny: Nest's SchemaObject type is narrower than JSON Schema
  ApiBody({ schema: openApiSchema(schema) as any });

/** Documents each query parameter from a Zod object schema. */
export function ApiZodQuery(schema: z.ZodType) {
  const json = openApiSchema(schema);
  const required = new Set(json.required ?? []);
  return applyDecorators(
    ...Object.entries(json.properties ?? {}).map(([name, property]) =>
      // biome-ignore lint/suspicious/noExplicitAny: see ApiZodBody
      ApiQuery({ name, required: required.has(name), schema: property as any }),
    ),
  );
}
