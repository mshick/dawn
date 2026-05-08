# UUIDv7 for Supabase primary keys

**Issue:** [#1 — Use uuidv7 for supabase primary keys by default](https://github.com/mshick/dawn/issues/1)
**Date:** 2026-05-08
**Status:** Approved

## Summary

Switch the project's UUID primary-key convention from `gen_random_uuid()` (UUIDv4) to a project-defined `public.uuid_generate_v7()` (UUIDv7). UUIDv7 prepends a 48-bit Unix-millisecond timestamp, so newly inserted rows cluster at the right edge of the B-tree index — improving insert locality, range scans by recency, and keyset pagination ordered by `id`.

Postgres 18 ships a native `uuidv7()` function, but Supabase is on Postgres 17. There is no Supabase-allowlisted extension that provides UUIDv7, so we define the function in pure plpgsql.

## Goals

- Provide a `public.uuid_generate_v7()` SQL function on every dawn database instance.
- Use it as the default for all UUID primary keys in current and future tables.
- Document the convention so future migrations follow it without rediscovery.

## Non-goals

- Replacing existing v4 IDs with v7 (no production data; `pnpm db:reset` is fine).
- Backwards-compatibility with environments that already have a deployed schema.
- CI/lint enforcement of the convention. Documentation-only for now; revisit if drift occurs.
- Custom column types, domains, or wrapper functions beyond the single generator.

## Design

### Function definition

Defined in the existing migration [supabase/migrations/20260507124222_chat_schema.sql](../../../supabase/migrations/20260507124222_chat_schema.sql), placed at the top of the file before any table:

```sql
create or replace function public.uuid_generate_v7()
returns uuid
language plpgsql
volatile
parallel safe
set search_path = pg_catalog, extensions
as $$
declare
  v_ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_bytes bytea  := gen_random_bytes(16);
begin
  -- 48-bit big-endian unix_ts_ms in bytes 0..5
  v_bytes := set_byte(v_bytes, 0, ((v_ts_ms >> 40) & 255)::int);
  v_bytes := set_byte(v_bytes, 1, ((v_ts_ms >> 32) & 255)::int);
  v_bytes := set_byte(v_bytes, 2, ((v_ts_ms >> 24) & 255)::int);
  v_bytes := set_byte(v_bytes, 3, ((v_ts_ms >> 16) & 255)::int);
  v_bytes := set_byte(v_bytes, 4, ((v_ts_ms >> 8)  & 255)::int);
  v_bytes := set_byte(v_bytes, 5, ( v_ts_ms        & 255)::int);
  -- version 7 in high nibble of byte 6
  v_bytes := set_byte(v_bytes, 6, (get_byte(v_bytes, 6) & 15) | 112);
  -- variant 10 in top two bits of byte 8
  v_bytes := set_byte(v_bytes, 8, (get_byte(v_bytes, 8) & 63) | 128);
  return encode(v_bytes, 'hex')::uuid;
end;
$$;

revoke all on function public.uuid_generate_v7() from public;
grant execute on function public.uuid_generate_v7() to authenticated, service_role, anon;
```

Notes:

- Conforms to RFC 9562 §5.7 (UUID Version 7).
- `gen_random_bytes` comes from `pgcrypto`, which Supabase enables by default.
- `volatile` is required (each call returns a different value); `parallel safe` is fine because `gen_random_bytes` and `clock_timestamp` are themselves parallel-safe.
- Pinning `search_path = pg_catalog, extensions` avoids resolution surprises under different invokers. `extensions` is included because Supabase installs `pgcrypto` (which provides `gen_random_bytes`) into that schema rather than `pg_catalog`.
- Execute is granted to the standard Supabase roles so the function is callable from RLS-protected inserts and from the service-role Kysely client.

### Migration edits

The same migration file changes both column defaults from `gen_random_uuid()` to `public.uuid_generate_v7()`:

- `public.threads.id`
- `public.messages.id`

`messages.superseded_by` remains a nullable FK with no default and is unaffected.

Final migration order in the file: function definition → `threads` table + index → `messages` table + indexes → trigger functions and triggers → RLS enable + policies.

### Convention documentation

Add a single bullet to `CLAUDE.md` under the existing "Conventions → Architecture" list:

> **UUID primary keys** — new tables with UUID PKs use `default public.uuid_generate_v7()` (defined in the chat-schema migration). Do not use `gen_random_uuid()` — UUIDv7's time-ordered prefix gives better B-tree locality and pagination.

## Verification

1. `pnpm db:reset` runs cleanly.
2. `select public.uuid_generate_v7();` returns a UUID whose 13th hex character (high nibble of byte 6) is `7`.
3. `select public.uuid_generate_v7(), pg_sleep(0.01) from generate_series(1, 5);` returns values whose text representation is strictly increasing (the 10 ms gap guarantees a different timestamp prefix per row). Without `pg_sleep`, ordering is only guaranteed across millisecond boundaries — within the same ms the random tail wins, which is RFC-compliant.
4. `pnpm generate` adds a single `Functions.uuid_generate_v7` entry to `src/lib/db/database.types.ts` (`{ Args: never; Returns: string }`). No column types change.
5. `pnpm typecheck` and `pnpm lint` pass.
6. Manual smoke test: sign in to `/chat`, send a message, confirm the new `threads.id` and `messages.id` rows have v7 UUIDs (timestamp prefix matches insert time).

## Risks / open questions

- **Clock skew between Postgres replicas:** UUIDv7 ordering is per-clock. On a single-writer Supabase instance this is a non-issue; flagged for future awareness if read-replicas ever generate IDs.
- **Performance vs. native C extension:** plpgsql is slower than `pg_uuidv7` or pg18's native `uuidv7()`. At current write volumes this is irrelevant. Migration to a native implementation later is a function-body swap; column defaults stay the same.
- **Postgres 18 upgrade:** when Supabase ships pg18, we can replace the body of `uuid_generate_v7()` with `select uuidv7()` (or alter defaults to call `uuidv7()` directly and drop the wrapper). No application code changes.
