# UUIDv7 Primary Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `gen_random_uuid()` with a project-defined `public.uuid_generate_v7()` for all UUID primary keys, and document the convention.

**Architecture:** Define a pure-plpgsql RFC-9562 v7 generator at the top of the existing chat-schema migration; switch both `id` column defaults from `gen_random_uuid()` to `public.uuid_generate_v7()`; add a one-line convention bullet to `CLAUDE.md`. No new extensions, no new migrations, no production data to migrate.

**Tech Stack:** Postgres 17 (Supabase), plpgsql, pgcrypto (`gen_random_bytes`), `pnpm db:reset` toolchain.

**Spec:** [docs/superpowers/specs/2026-05-08-uuidv7-primary-keys-design.md](../specs/2026-05-08-uuidv7-primary-keys-design.md)

**Issue:** [#1](https://github.com/mshick/dawn/issues/1)

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `supabase/migrations/20260507124222_chat_schema.sql` | Modify | Add `uuid_generate_v7()` function definition; switch `threads.id` and `messages.id` defaults to use it. |
| `CLAUDE.md` | Modify | Document the UUIDv7 convention so future migrations follow it. |

No new files. No test files (verification is `pnpm db:reset` + a `select` smoke check + `pnpm typecheck`/`pnpm lint`; the project has no SQL test framework, and adding one is out of scope).

---

## Task 1: Add `uuid_generate_v7()` and switch PK defaults

**Goal:** The chat-schema migration defines `public.uuid_generate_v7()` and uses it as the default for both `threads.id` and `messages.id`. `pnpm db:reset` succeeds and inserts produce v7 UUIDs.

**Files:**
- Modify: `supabase/migrations/20260507124222_chat_schema.sql`

**Acceptance Criteria:**
- [ ] `public.uuid_generate_v7()` exists in the database after `pnpm db:reset`.
- [ ] `select public.uuid_generate_v7();` returns a UUID whose 13th hex character is `7` (version nibble).
- [ ] `select public.uuid_generate_v7(), pg_sleep(0.01) from generate_series(1, 5);` returns 5 strictly increasing UUIDs.
- [ ] `pg_get_expr(adbin, adrelid)` for the `id` columns of `public.threads` and `public.messages` evaluates to `uuid_generate_v7()`.
- [ ] `pnpm generate` adds a single `Functions.uuid_generate_v7` entry to `src/lib/db/database.types.ts`; no column-type changes.
- [ ] `pnpm typecheck` and `pnpm lint` pass.

**Verify:** Sequence of commands below — see Step 4.

**Steps:**

- [ ] **Step 1: Edit the migration**

Open `supabase/migrations/20260507124222_chat_schema.sql`. The file currently begins with the comment `-- threads ...` and `create table public.threads`. Insert the function definition above the threads section, and change the two `default gen_random_uuid()` clauses to `default public.uuid_generate_v7()`.

The final state of the relevant top of the file should be:

```sql
-- uuid v7 generator -----------------------------------------------------------

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

-- threads --------------------------------------------------------------------

create table public.threads (
  id uuid primary key default public.uuid_generate_v7(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

And the messages table's `id`:

```sql
create table public.messages (
  id uuid primary key default public.uuid_generate_v7(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  ...
```

Leave everything else (indexes, triggers, RLS policies, `messages.superseded_by`) unchanged.

- [ ] **Step 2: Re-apply the migration locally**

Make sure Supabase is running, then reset:

```bash
pnpm db:start    # only if not already up
pnpm db:reset
```

Expected: `Database reset successful` (or equivalent), no SQL errors.

If `db:reset` fails with a syntax error, re-read the function body — the `>>`/`&`/`|` precedence requires the parens shown above; do not "simplify" them.

- [ ] **Step 3: Smoke-test the function and defaults**

Connect to the local DB. Easiest path:

```bash
psql "$(supabase status -o env | sed -n 's/^DB_URL=//p' | tr -d '"')" \
  -c "select public.uuid_generate_v7();" \
  -c "select public.uuid_generate_v7(), pg_sleep(0.01) from generate_series(1, 5);" \
  -c "select pg_get_expr(adbin, adrelid)
        from pg_attrdef d
        join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
        join pg_class c on c.oid = d.adrelid
       where c.relname in ('threads','messages') and a.attname = 'id';"
```

Expected:

1. First query: a single UUID, e.g. `01f3a9c8-6b54-7c2e-8a91-2e9f...` (13th hex char is `7`).
2. Second query: 5 rows, UUIDs strictly increasing in lexical order.
3. Third query: two rows, both `uuid_generate_v7()`.

If the version nibble isn't `7`, the bit math is wrong — re-check the `| 112` (binary `01110000`) on byte 6.

- [ ] **Step 4: Regenerate types and run static checks**

```bash
pnpm generate
pnpm typecheck
pnpm lint
```

Expected:

- `pnpm generate` adds only the new `Functions.uuid_generate_v7` entry to `src/lib/db/database.types.ts`; column types unchanged.
- `pnpm typecheck` exits 0.
- `pnpm lint` exits 0.

The expected diff is one new entry under `Functions.uuid_generate_v7` in `Database.public`. Any change to existing column types is unexpected and should be investigated.

- [ ] **Step 5: End-to-end smoke (optional but recommended)**

```bash
pnpm dev
```

In a browser, sign in and create a chat thread + send a message. Then in psql:

```sql
select id, created_at from public.threads order by created_at desc limit 1;
select id, created_at from public.messages order by created_at desc limit 1;
```

Expected: the new rows' `id`s have version nibble `7` and their text-sort order matches `created_at` order.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260507124222_chat_schema.sql
git commit -m "Use uuid_generate_v7() for threads/messages PKs (#1)"
```

---

## Task 2: Document UUIDv7 convention in CLAUDE.md

**Goal:** Future contributors (human or agent) reading `CLAUDE.md` see the rule and don't reach for `gen_random_uuid()` again.

**Files:**
- Modify: `CLAUDE.md`

**Acceptance Criteria:**
- [ ] `CLAUDE.md` contains a bullet under "Conventions → Architecture" describing the UUIDv7 PK rule and pointing at the chat-schema migration.
- [ ] No other unrelated edits.

**Verify:** `git diff CLAUDE.md` shows only the new bullet; `pnpm lint` passes (Biome doesn't lint Markdown but the command should still exit 0).

**Steps:**

- [ ] **Step 1: Add the convention bullet**

Open `CLAUDE.md` and locate the "Conventions" section, "Architecture" subsection (the bulleted list that includes "Leverage the framework, don't reinvent it" and "No packaged ORMs"). Add this bullet, placed adjacent to the other DB-related bullets ("Server vs client Supabase" / "Generated files" / "DB writes"):

```markdown
- **UUID primary keys** — new tables with UUID PKs use
  `default public.uuid_generate_v7()` (defined in the chat-schema migration).
  Do not use `gen_random_uuid()`. UUIDv7's time-ordered prefix gives better
  B-tree locality and keyset pagination than v4.
```

- [ ] **Step 2: Verify and commit**

```bash
git diff CLAUDE.md
pnpm lint
git add CLAUDE.md
git commit -m "Document UUIDv7 primary key convention (#1)"
```

Expected: diff shows only the new bullet; lint exits 0.

---

## Self-Review

- **Spec coverage:**
  - Function definition → Task 1 Step 1.
  - Migration edits (both column defaults) → Task 1 Step 1.
  - Convention documentation → Task 2.
  - Verification (db:reset, version-nibble check, monotonic check, types/typecheck/lint, manual smoke) → Task 1 Steps 2–5.
  - All spec sections covered.
- **Placeholder scan:** No TBD/TODO/"add appropriate X" patterns. All code shown explicitly.
- **Type/name consistency:** Function name `public.uuid_generate_v7()` consistent across spec, migration, CLAUDE.md text, and verification queries. Column names (`threads.id`, `messages.id`) match the existing schema.
- **No invented dependencies:** `gen_random_bytes` ships with Supabase's default `pgcrypto`; `set_byte`, `get_byte`, `clock_timestamp`, `extract` are stdlib.
