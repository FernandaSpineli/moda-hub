-- Extensions and helpers the schema depends on; Drizzle's schema DSL cannot
-- express them, so they live in a hand-written migration that runs first.

CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint

-- unaccent() is only STABLE (its dictionary could change), so it cannot be
-- used in a generated column. This wrapper pins the dictionary and is
-- declared IMMUTABLE, the standard way to index accent-insensitive text:
-- "algodao" then finds "algodão".
CREATE FUNCTION f_unaccent(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
RETURN public.unaccent('public.unaccent'::regdictionary, $1);
--> statement-breakpoint

-- Keeps updated_at correct no matter which code path updates a row.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;
