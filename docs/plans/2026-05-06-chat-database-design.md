# Chat Database Design

**Status:** Validated, ready to plan implementation
**Date:** 2026-05-06
**Related:** [src/app/api/chat/route.ts](../../src/app/api/chat/route.ts), [src/lib/inngest/functions.ts](../../src/lib/inngest/functions.ts), [src/lib/db/index.ts](../../src/lib/db/index.ts), [CLAUDE.md](../../CLAUDE.md)

## Summary

Persist chat traffic (threads, messages, run telemetry) in Supabase, gate the app behind Supabase Auth (OAuth: GitHub + Google), and rewire the existing Inngest streaming pipeline so the database is the source of truth instead of the client. Schema owned by Supabase migrations; types flow `SQL → database.types.ts → Kysely`.

## Decisions

| Question | Choice |
|---|---|
| Persistence scope | Auth + threads + messages + per-row Inngest run telemetry |
| Streaming durability | Insert-then-update with debounced UPDATE on the assistant `messages` row |
| Chat features | Linear with regenerate (soft-replace via `superseded_at`) |
| Auth method | OAuth (GitHub / Google) via Supabase Auth |
| User table | None — FK directly to `auth.users(id)`. No separate `profiles` table |
| Inngest DB writes | Service-role key, RLS bypassed; trust boundary at `/api/chat` |
| Thread titles | Truncated from first user message (no summarization function) |

## Schema

Two tables in `public`, both owned by `auth.users`. RLS enabled on both.

### `threads`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK, default `gen_random_uuid()` | |
| `user_id` | `uuid` NOT NULL | FK → `auth.users(id)` ON DELETE CASCADE |
| `title` | `text` | Nullable; populated from first user message (truncated to ~60 chars) |
| `created_at` | `timestamptz` default `now()` | |
| `updated_at` | `timestamptz` default `now()` | Trigger bumps on message insert |

### `messages`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK, default `gen_random_uuid()` | |
| `thread_id` | `uuid` NOT NULL | FK → `threads(id)` ON DELETE CASCADE |
| `role` | `text` NOT NULL | CHECK `role IN ('user','assistant','system')` |
| `content` | `text` NOT NULL default `''` | Accumulates during streaming via debounced UPDATEs |
| `superseded_at` | `timestamptz` | NULL = active; set when regenerated |
| `superseded_by` | `uuid` | FK → `messages(id)` ON DELETE SET NULL |
| `created_at` | `timestamptz` default `now()` | Stream start |
| `completed_at` | `timestamptz` | Stream end (or NULL while in flight) |
| `inngest_run_id` | `text` | From Inngest function context |
| `model` | `text` | E.g. `'claude-sonnet-4-6'` |
| `finish_reason` | `text` | `stop`, `length`, `error`, `timeout` |
| `input_tokens` | `int` | Nullable |
| `output_tokens` | `int` | Nullable |
| `latency_ms` | `int` | `completed_at - created_at`, ms |

### Indexes

- `threads(user_id, updated_at DESC)` — sidebar listing
- `messages(thread_id, created_at) WHERE superseded_at IS NULL` — render path
- `messages(inngest_run_id)` — telemetry joins

### Triggers

- `BEFORE INSERT ON messages FOR EACH ROW`: `UPDATE threads SET updated_at = now() WHERE id = NEW.thread_id`
- `BEFORE UPDATE ON threads FOR EACH ROW`: `NEW.updated_at = now()`

### RLS

All policies use `auth.uid()` directly.

- `threads`: SELECT/INSERT/UPDATE/DELETE `WHERE user_id = auth.uid()`
- `messages`: same predicate via subquery on parent `threads`

The Inngest function bypasses RLS via `SUPABASE_SERVICE_ROLE_KEY`. The trust boundary is `/api/chat` — that route validates the user owns the thread before sending the event.

## Migrations & codegen

Schema is owned by Supabase migrations. Kysely is read-side only; no second migration tool.

```bash
pnpm supabase init                               # one-time
pnpm supabase migration new 0001_chat_schema    # write the SQL by hand
pnpm db:reset                                    # apply locally
```

Type flow:

```
SQL → Supabase → src/lib/db/database.types.ts → KyselifyDatabase<Database> → Kysely
```

[scripts/generate.mjs](../../scripts/generate.mjs) already runs `supabase gen types` when `supabase/config.toml` exists. The first run after `supabase init` populates `database.types.ts` for real, replacing the empty stub. `pnpm dev`'s `predev` step picks it up automatically.

### OAuth provider config

Local dev: `supabase/config.toml` references `env(...)` for client ID + secret. Prod: configure in Supabase dashboard.

```toml
[auth.external.github]
enabled = true
client_id = "env(SUPABASE_AUTH_GITHUB_CLIENT_ID)"
secret = "env(SUPABASE_AUTH_GITHUB_SECRET)"
redirect_uri = "http://127.0.0.1:54321/auth/v1/callback"

[auth.external.google]
enabled = true
client_id = "env(SUPABASE_AUTH_GOOGLE_CLIENT_ID)"
secret = "env(SUPABASE_AUTH_GOOGLE_SECRET)"
redirect_uri = "http://127.0.0.1:54321/auth/v1/callback"
```

OAuth client setup (manual): create apps at `https://github.com/settings/developers` and `https://console.cloud.google.com/apis/credentials`, callback `<supabase-url>/auth/v1/callback`. Drop client IDs/secrets in `.env.local`.

## Auth wiring

Three layers:

1. **`src/proxy.ts`** — already exists, refreshes the session cookie. Unchanged.
2. **Route-group gate** — protected pages live under `(authed)/`. The group's `layout.tsx` calls `auth.getUser()` and redirects to `/login` if absent.
3. **API route handlers** — `/api/chat` does its own `auth.getUser()` check and returns 401 if missing. RLS would catch unauthorized DB writes, but failing fast is cleaner UX.

```
src/app/
  login/
    page.tsx                  # public — "Continue with GitHub" / "Google" buttons
    actions.ts                # server actions: signInWithGitHub, signInWithGoogle
  auth/callback/route.ts      # exchangeCodeForSession → redirect ?next= (default /chat)
  (authed)/
    layout.tsx                # auth.getUser() or redirect("/login")
    chat/page.tsx             # current chat UI moves here
```

`(authed)` is a route group — the parens mean it doesn't appear in the URL, so `/chat` stays `/chat`.

Sign-in server action shape:

```ts
'use server';
export async function signInWithGitHub() {
  const supabase = await createClient();
  const { data } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: `${origin}/auth/callback?next=/chat` },
  });
  redirect(data.url);
}
```

Sign-out is a server action calling `supabase.auth.signOut()`, surfaced as a button in the chat layout.

## Chat data flow

The wire contract changes — `/api/chat` no longer ships full message history. The database is the source of truth.

### Send-message flow

1. Client `POST /api/chat` with `{ thread_id?: string, content: string }`.
2. Route, in a single transaction:
   - `auth.getUser()` → 401 if absent
   - If no `thread_id`: `INSERT INTO threads (user_id, title) VALUES ($1, substr($2, 1, 60)) RETURNING id`
   - `INSERT INTO messages (thread_id, role='user', content, completed_at=now())`
   - `INSERT INTO messages (thread_id, role='assistant', content='') RETURNING id` ← `assistant_message_id`
3. Generate `streamId`, open the realtime subscription, then `inngest.send({ name: 'chat/message.requested', data: { thread_id, assistant_message_id, streamId } })`.
4. Return SSE response with headers `X-Thread-Id` and `X-Assistant-Message-Id` so the client can update its URL/state immediately.

### Regenerate flow

`POST /api/chat` with `{ regenerate_message_id }`. Route:

1. Verifies ownership of the thread containing that message.
2. `UPDATE messages SET superseded_at = now() WHERE id = $1 AND role = 'assistant'`.
3. `INSERT INTO messages (thread_id, role='assistant', content='') RETURNING id`.
4. (Optionally `UPDATE messages SET superseded_by = $new WHERE id = $old` to preserve the chain — a nicety, not required for correctness.)
5. Same Inngest event + SSE return path as send-message.

### Inngest function changes

- Open a Kysely connection backed by `SUPABASE_SERVICE_ROLE_KEY` (server-only). Document the trust boundary.
- Load active history: `SELECT … WHERE thread_id = $1 AND superseded_at IS NULL AND id != $assistant_message_id ORDER BY created_at`.
- Map to ai-sdk `ModelMessage` shape; pass to `streamText`.
- For each delta:
  - Append to local buffer
  - Publish `delta` to realtime (as today)
  - If ≥ 250ms since last DB write, `UPDATE messages SET content = $1 WHERE id = $2`
- On completion, one final UPDATE writes everything: `content`, `completed_at = now()`, `finish_reason`, `model`, `input_tokens`, `output_tokens`, `latency_ms`, `inngest_run_id`. Then publish `done`.
- On error, publish `error` and write `finish_reason = 'error'`, `completed_at = now()`. Partial `content` stays for forensics.

### Client changes

- `/chat` becomes a server component: fetches the user's most recent thread + active messages via the request-scoped Supabase server client, or renders an empty state. Thread sidebar fetches `threads` ordered by `updated_at DESC`.
- Send / regenerate hit `/api/chat` with the new request shapes; SSE consumer is unchanged from today.
- Mid-stream reload renders the partial `content` from the DB. Live continuation across reloads is **out of scope**.

## Stuck-stream cleanup

If the Inngest function dies mid-execution (rare but possible), `messages` rows can sit with `completed_at IS NULL` indefinitely. Add an Inngest cron function:

- Trigger: every 5 minutes
- Action: `UPDATE messages SET finish_reason = 'timeout', completed_at = now() WHERE completed_at IS NULL AND created_at < now() - interval '5 minutes'`
- Effect: UI sees a clean signal to allow regenerate

## Out of scope (cuts)

- `profiles` table — denormalize from `auth.users` later if profile UI emerges
- Mid-stream live resume across reloads (needs persisted `streamId` + a `?resume=true` flag)
- LLM-generated thread title summarization (truncate from first message instead)
- Multi-org / workspaces
- Message tags, search, exports
- Thread soft-delete (hard DELETE for now; ON DELETE CASCADE handles messages)
- Message editing (regenerate-of-latest only)
- Anonymous auth path

## Implementation order

Each step builds on the previous; verify each works before moving to the next.

1. **Schema + migrations.** `supabase init`; write `0001_chat_schema.sql` with both tables, indexes, triggers, RLS. `pnpm db:reset`. Confirm `pnpm db:types` regenerates `database.types.ts` and Kysely's `DB` type updates.
2. **Service-role Kysely client.** Add `SUPABASE_SERVICE_ROLE_KEY` to env validation. Create a second Kysely client (or reuse with the service role connection string) for server-side trusted writes. Document the trust boundary.
3. **Auth scaffolding.** `/login` page + server actions, `/auth/callback` route, `(authed)/layout.tsx` gate. Move `/chat` into the group. OAuth providers configured in `supabase/config.toml`. Add `SUPABASE_AUTH_GITHUB_*` and `SUPABASE_AUTH_GOOGLE_*` to `.env.example`.
4. **Route changes.** Rewrite `/api/chat` to take `{ thread_id?, content }` or `{ regenerate_message_id }`, do auth check, perform DB inserts, return SSE with `X-Thread-Id` / `X-Assistant-Message-Id` headers.
5. **Inngest function changes.** Switch from event-payload-driven history to DB-loaded history. Add debounced `UPDATE` of `messages.content`. Final UPDATE writes telemetry on `done`/`error`.
6. **Client changes.** `/chat` becomes a server component with thread + message hydration. Sidebar of threads. Regenerate button on each assistant message.
7. **Stuck-stream cron.** Inngest cron function for `completed_at IS NULL` timeouts.

## Open questions for implementation

- Confirm GitHub vs Google vs both at OAuth-app-creation time (decision is mechanical, doesn't change schema or code shape — both can coexist).
- `superseded_by` link: tighten the chain by setting it on the old row when regenerating, or leave NULL? Adds one UPDATE; useful for auditing how many regenerations a prompt had. Default: set it.
- Debounce interval: 250ms is a reasonable default; can tune by watching DB write rate during streaming.
