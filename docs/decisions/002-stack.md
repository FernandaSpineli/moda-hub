# ADR 002 — Stack: NestJS, Drizzle, Zod and TypeScript 6

- **Status:** accepted
- **Date:** 2026-10-08

## Context

The service needs modules with clear boundaries (auth, catalogue, cart,
orders, payments, jobs), two processes from one codebase (API and worker),
SQL that it controls precisely (row locks, recursive queries, full-text
search), and one description of each request that both validates it and
documents it.

## Decisions

**NestJS 12 on Express.** Dependency injection and modules make the API and
the worker share a `PlatformModule` (database, Redis, mailer, config) while
wiring different things on top. Guards, pipes, interceptors and filters give
one place each for authentication, validation, idempotency and error
mapping. Express rather than Fastify: Stripe signs the raw body, and the
Express adapter's `rawBody` support is the most proven path.

**Drizzle ORM, with SQL where it matters.** The schema is TypeScript and
generates migrations, so tables and types cannot drift. Queries that are
plain CRUD use the query builder; the ones that carry the business rules
(stock reservation under `FOR UPDATE`, the category tree's recursive CTE,
search ranking, keyset pagination) are written as SQL through Drizzle's
`sql` template, which still parameterises every value. Prisma was the
alternative; its generated client and query engine make that kind of SQL
and transaction control harder to see.

Hand-written migrations sit beside the generated ones for what Drizzle does
not model: extensions (`citext`, `unaccent`), an immutable `f_unaccent` for
indexing, and `updated_at` triggers.

**Zod for every input, and for the OpenAPI document.** `nestjs-zod` does not
support Nest 12, so a 40-line `ZodValidationPipe` does the parsing, and
`z.toJSONSchema` turns the same schemas into OpenAPI request bodies and
query parameters (`ApiZodBody`, `ApiZodQuery`). Validation messages name the
field, including unknown ones (`"role" is not allowed`), so mass assignment
fails loudly.

**TypeScript 6, not 7.** `@nestjs/swagger` 12 declares TypeScript `^5.5 ||
^6` and Nest relies on legacy decorators with emitted metadata, which the
native TypeScript 7 compiler does not support yet. Revisit when both do.

**Biome** for lint and format (one fast tool, no plugin sprawl), **Vitest**
with SWC (decorator metadata) and **Testcontainers** for real PostgreSQL,
Redis and Mailpit in tests.

## Consequences

- Nest adds ceremony (modules, providers, tokens) that a small service would
  not need; here it pays for itself in the API/worker split and in
  cross-cutting concerns.
- Hand-written SQL must be covered by integration tests, since the type
  checker cannot see inside it; it is.
- The validation pipe and OpenAPI helpers are ours to maintain, but small
  and tested.
