# Chat Database Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Persist chat (threads + messages + per-row Inngest run telemetry) in Supabase, gate the app behind OAuth (GitHub + Google), and rewire `/api/chat` + the Inngest function so the database is the source of truth.

**Architecture:** Schema is owned by Supabase migrations; Kysely is read-side. Streaming uses insert-then-update on the assistant `messages` row with a 250ms debounce. Regenerate is a soft-replace via `superseded_at`. The Inngest function bypasses RLS via the service-role key; trust boundary is at `/api/chat` which performs `auth.getUser()`.

**Tech Stack:** Next.js App Router (Turbopack), Supabase Auth + Postgres, Kysely + `pg`, Inngest + `inngest/realtime`, ai-sdk + `@ai-sdk/anthropic`, Biome + Vitest, pnpm.

**Source of decisions:** [docs/plans/2026-05-06-chat-database-design.md](./2026-05-06-chat-database-design.md). Read that first. This document only translates decisions into concrete tasks.

**Working directory for execution:** `/Users/mshick/Code/mshick/dawn/.worktrees/chat-database` on branch `feature/chat-database`. Baseline (typecheck, lint, 1 test) is clean.

**Conventions for this plan:**
- TDD where it adds value (utility functions, route logic, parser tests). For SQL migrations, config files, and one-shot wiring tasks: write code → run a verification command → commit. Do not invent ceremonial tests.
- Run `pnpm typecheck` and `pnpm exec biome check .` before each commit. Fix any issues before committing.
- Frequent, small commits (one task = one commit) with conventional-commit-style subjects.
- All file paths are relative to the worktree root.

---

## Phase 1 — Schema + migrations

Get the schema in place and the type pipeline flowing.

### Task 1.1 — Initialize the local Supabase project

**Files:** Creates `supabase/config.toml`, `supabase/seed.sql`, `supabase/.gitignore`, etc.

**Step 1:** Run `pnpm exec supabase init`.

Expected: prints "Generated config..." and a directory listing. If it asks about VS Code settings, decline.

**Step 2:** Verify the project files appeared:

```bash
ls supabase/
```

Expected output includes `config.toml`, `seed.sql`.

**Step 3:** Commit.

```bash
git add supabase/
git commit -m "chore(db): init local Supabase project"
```

---

### Task 1.2 — Write the schema migration

**Files:**
- Create: `supabase/migrations/0001_chat_schema.sql`

**Step 1:** Generate the migration file:

```bash
pnpm exec supabase migration new chat_schema
```

Expected: creates `supabase/migrations/<timestamp>_chat_schema.sql`. Note the actual filename — Supabase prefixes with a timestamp, not `0001`.

**Step 2:** Replace the empty file with the schema. Paste this verbatim:

```sql
-- threads --------------------------------------------------------------------

create table public.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index threads_user_id_updated_at_idx
  on public.threads (user_id, updated_at desc);

-- messages -------------------------------------------------------------------

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null default '',
  superseded_at timestamptz,
  superseded_by uuid references public.messages(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  -- telemetry (assistant rows)
  inngest_run_id text,
  model text,
  finish_reason text,
  input_tokens int,
  output_tokens int,
  latency_ms int
);

create index messages_thread_id_created_at_active_idx
  on public.messages (thread_id, created_at)
  where superseded_at is null;

create index messages_inngest_run_id_idx
  on public.messages (inngest_run_id);

-- triggers: bump threads.updated_at on message insert ------------------------

create or replace function public.touch_thread_on_message_insert()
returns trigger language plpgsql as $$
begin
  update public.threads set updated_at = now() where id = new.thread_id;
  return new;
end;
$$;

create trigger messages_touch_thread
  after insert on public.messages
  for each row execute function public.touch_thread_on_message_insert();

create or replace function public.touch_threads_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger threads_touch_updated_at
  before update on public.threads
  for each row execute function public.touch_threads_updated_at();

-- RLS ------------------------------------------------------------------------

alter table public.threads enable row level security;
alter table public.messages enable row level security;

-- threads policies
create policy "threads_select_own" on public.threads
  for select using (user_id = auth.uid());
create policy "threads_insert_own" on public.threads
  for insert with check (user_id = auth.uid());
create policy "threads_update_own" on public.threads
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "threads_delete_own" on public.threads
  for delete using (user_id = auth.uid());

-- messages policies (ownership via parent thread)
create policy "messages_select_own" on public.messages
  for select using (
    exists (
      select 1 from public.threads t
      where t.id = messages.thread_id and t.user_id = auth.uid()
    )
  );
create policy "messages_insert_own" on public.messages
  for insert with check (
    exists (
      select 1 from public.threads t
      where t.id = messages.thread_id and t.user_id = auth.uid()
    )
  );
create policy "messages_update_own" on public.messages
  for update using (
    exists (
      select 1 from public.threads t
      where t.id = messages.thread_id and t.user_id = auth.uid()
    )
  );
create policy "messages_delete_own" on public.messages
  for delete using (
    exists (
      select 1 from public.threads t
      where t.id = messages.thread_id and t.user_id = auth.uid()
    )
  );
```

**Step 3:** Apply locally and verify it doesn't error.

```bash
pnpm db:start    # starts the local Supabase stack via Docker (slow first run)
pnpm db:reset    # applies all migrations + seed
```

Expected: no errors. The reset prints "Applying migration ..._chat_schema.sql..." and "Seeding data...".

**Step 4:** Sanity check — connect to the DB and `\d` the tables.

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d public.threads"
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d public.messages"
```

Expected: both tables print with the columns + indexes from the migration.

**Step 5:** Commit.

```bash
git add supabase/migrations/
git commit -m "feat(db): add threads + messages schema with RLS"
```

---

### Task 1.3 — Regenerate `database.types.ts` and confirm Kysely picks it up

**Files:**
- Modify: `src/lib/db/database.types.ts` (regenerated)

**Step 1:** Run the generator.

```bash
pnpm generate
```

Expected: prints `[generate] Generating Supabase types from local schema…` and `[generate] Wrote .../src/lib/db/database.types.ts`.

**Step 2:** Confirm the file is no longer the empty stub.

```bash
grep -E "threads|messages" src/lib/db/database.types.ts | head
```

Expected: matches both table names.

**Step 3:** Confirm Kysely's typed client compiles against the new schema by writing a tiny smoke test that constructs a query but doesn't execute it.

Create `src/lib/db/types.test.ts`:

```ts
import { describe, expectTypeOf, it } from 'vitest';
import type { DB } from './types';

describe('Kysely DB types', () => {
  it('exposes threads and messages tables', () => {
    expectTypeOf<keyof DB>().toExtend<'threads' | 'messages'>();
  });

  it('threads has user_id of uuid', () => {
    expectTypeOf<DB['threads']['user_id']>().toExtend<string>();
  });

  it('messages has nullable superseded_at', () => {
    expectTypeOf<DB['messages']['superseded_at']>().toExtend<Date | null>();
  });
});
```

**Step 4:** Run the test.

```bash
pnpm test
```

Expected: 2 test files (the existing `utils.test.ts` plus the new one), all passing.

**Step 5:** Typecheck + lint.

```bash
pnpm typecheck && pnpm exec biome check .
```

Expected: both clean.

**Step 6:** Commit.

```bash
git add src/lib/db/database.types.ts src/lib/db/types.test.ts
git commit -m "feat(db): regenerate Supabase types and add Kysely type smoke test"
```

---

## Phase 2 — Service-role Kysely client

The Inngest function needs RLS-bypassing DB access. The user-facing path keeps using the standard pooled client.

### Task 2.1 — Add `SUPABASE_SERVICE_ROLE_KEY` to env validation and `.env.example`

**Files:**
- Modify: `src/lib/env.ts`
- Modify: `.env.example`

**Step 1:** In `src/lib/env.ts`, the server schema already declares `SUPABASE_SERVICE_ROLE_KEY` as optional. Leave it optional (it's only required at function-execution time, not at boot). No change needed unless it isn't there — verify with `grep "SUPABASE_SERVICE_ROLE_KEY" src/lib/env.ts`.

**Step 2:** In `.env.example`, the variable is already listed. Verify; if missing, add it under `# --- Supabase ---`.

**Step 3:** No commit yet — wait for the client itself in 2.2.

---

### Task 2.2 — Add a service-role Kysely client

**Files:**
- Create: `src/lib/db/admin.ts`

**Step 1:** Write the file. Pattern matches existing [src/lib/db/index.ts](src/lib/db/index.ts) — global-cached singleton, server-only. The connection string for the service-role client is the same `SUPABASE_DB_URL` (the local DB Postgres URL bypasses RLS regardless of role; in production the same URL is fine because Postgres connections via the direct URL run as the `postgres` superuser, which bypasses RLS by default). The reason this file exists separately from `index.ts` is **clarity of intent**: code that imports `@/lib/db/admin` is announcing it's making a privileged write.

```ts
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './types';

const globalForAdminDb = globalThis as unknown as {
  adminDb?: Kysely<DB>;
  adminPool?: Pool;
};

function createAdminPool() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(
      'SUPABASE_DB_URL is not set. The admin (service-role) Kysely client requires it.',
    );
  }
  return new Pool({ connectionString, max: 5 });
}

/**
 * Privileged Kysely client. Connects with the postgres superuser, bypassing
 * RLS. Only import this from server code that has already validated user
 * ownership upstream — currently:
 *
 *   - The Inngest function `chatStream` (trust boundary at `/api/chat`).
 *
 * Never import from a `'use client'` file. Never import from a route handler
 * before checking `auth.getUser()`.
 */
export const adminDb: Kysely<DB> =
  globalForAdminDb.adminDb ??
  new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: globalForAdminDb.adminPool ?? createAdminPool(),
    }),
  });

if (process.env.NODE_ENV !== 'production') {
  globalForAdminDb.adminDb = adminDb;
}
```

**Step 2:** Typecheck + lint.

```bash
pnpm typecheck && pnpm exec biome check .
```

Expected: both clean.

**Step 3:** Commit.

```bash
git add src/lib/db/admin.ts
git commit -m "feat(db): add service-role Kysely client for trusted server writes"
```

---

## Phase 3 — Auth scaffolding

Add OAuth login, callback, and a route-group gate for the chat.

### Task 3.1 — OAuth provider env vars

**Files:**
- Modify: `src/lib/env.ts`
- Modify: `.env.example`

**Step 1:** Add to the server schema in `src/lib/env.ts`:

```ts
SUPABASE_AUTH_GITHUB_CLIENT_ID: z.string().min(1).optional(),
SUPABASE_AUTH_GITHUB_SECRET: z.string().min(1).optional(),
SUPABASE_AUTH_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
SUPABASE_AUTH_GOOGLE_SECRET: z.string().min(1).optional(),
```

**Step 2:** Mirror in `.env.example` under a new `# --- OAuth ---` section.

**Step 3:** Typecheck.

```bash
pnpm typecheck
```

Expected: clean.

**Step 4:** Commit.

```bash
git add src/lib/env.ts .env.example
git commit -m "feat(auth): add OAuth provider env vars"
```

---

### Task 3.2 — Configure OAuth providers in `supabase/config.toml`

**Files:**
- Modify: `supabase/config.toml`

**Step 1:** Find the `[auth.external]` section in the generated config (or `[auth.external.github]` etc. — the file uses one block per provider). Add or enable:

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

If those sections already exist with `enabled = false`, just flip them.

**Step 2:** Restart the local stack to pick up the config change.

```bash
pnpm db:stop && pnpm db:start
```

Expected: starts cleanly. (Without OAuth env vars set in `.env.local`, the providers boot but auth attempts will fail — that's fine for now.)

**Step 3:** Commit.

```bash
git add supabase/config.toml
git commit -m "feat(auth): enable GitHub + Google providers in supabase config"
```

---

### Task 3.3 — `/login` page and OAuth server actions

**Files:**
- Create: `src/app/login/page.tsx`
- Create: `src/app/login/actions.ts`

**Step 1:** Server actions in `src/app/login/actions.ts`:

```ts
'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

async function signInWith(provider: 'github' | 'google') {
  const supabase = await createClient();
  const origin = (await headers()).get('origin') ?? 'http://localhost:3000';

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${origin}/auth/callback?next=/chat` },
  });

  if (error || !data.url) {
    redirect(`/login?error=${encodeURIComponent(error?.message ?? 'oauth_failed')}`);
  }

  redirect(data.url);
}

export async function signInWithGitHub() {
  await signInWith('github');
}

export async function signInWithGoogle() {
  await signInWith('google');
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
```

**Step 2:** Login page in `src/app/login/page.tsx`:

```tsx
import { Button } from '@/components/ui/button';
import { signInWithGitHub, signInWithGoogle } from './actions';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-sm flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Sign in to dawn</h1>

      {error && (
        <p className="w-full rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex w-full flex-col gap-2">
        <form action={signInWithGitHub}>
          <Button type="submit" className="w-full" variant="outline">
            Continue with GitHub
          </Button>
        </form>
        <form action={signInWithGoogle}>
          <Button type="submit" className="w-full" variant="outline">
            Continue with Google
          </Button>
        </form>
      </div>
    </main>
  );
}
```

**Step 3:** Typecheck + lint.

```bash
pnpm typecheck && pnpm exec biome check .
```

Expected: both clean.

**Step 4:** Commit.

```bash
git add src/app/login/
git commit -m "feat(auth): add /login page with OAuth server actions"
```

---

### Task 3.4 — `/auth/callback` route handler

**Files:**
- Create: `src/app/auth/callback/route.ts`

**Step 1:**

```ts
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/chat';

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=missing_code', url.origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, url.origin),
    );
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
```

**Step 2:** Typecheck + lint.

```bash
pnpm typecheck && pnpm exec biome check .
```

**Step 3:** Commit.

```bash
git add src/app/auth/callback/
git commit -m "feat(auth): add OAuth callback route"
```

---

### Task 3.5 — Route-group gate and move `/chat` into `(authed)/`

**Files:**
- Create: `src/app/(authed)/layout.tsx`
- Move: `src/app/chat/` → `src/app/(authed)/chat/`

**Step 1:** Move the chat directory.

```bash
mkdir -p "src/app/(authed)"
git mv src/app/chat "src/app/(authed)/chat"
```

**Step 2:** Create `src/app/(authed)/layout.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { signOut } from '@/app/login/actions';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2 text-sm">
        <span className="text-muted-foreground">{user.email ?? user.id}</span>
        <form action={signOut}>
          <Button type="submit" size="sm" variant="ghost">
            Sign out
          </Button>
        </form>
      </header>
      <div className="flex flex-1">{children}</div>
    </div>
  );
}
```

**Step 3:** Typecheck + lint.

```bash
pnpm typecheck && pnpm exec biome check .
```

Expected: both clean. The existing chat page should still render — its imports use `@/...` aliases, which are unaffected by the move.

**Step 4:** Commit.

```bash
git add -A
git commit -m "feat(auth): add (authed) route group gate; move /chat into it"
```

---

## Phase 4 — Rewrite `/api/chat`

The route stops trusting the client's message history and persists everything itself.

### Task 4.1 — Define the new request types and update the route

**Files:**
- Modify: `src/app/api/chat/route.ts`

**Step 1:** Replace the file. The new shape: accept either `{thread_id?, content}` (send) or `{regenerate_message_id}` (regenerate). Auth-check; do all DB writes; emit Inngest event with `{thread_id, assistant_message_id, streamId}`; return SSE.

```ts
import { subscribe } from 'inngest/realtime';
import { adminDb } from '@/lib/db/admin';
import { chatChannel } from '@/lib/inngest/channels';
import { inngest } from '@/lib/inngest/client';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

type SendBody = { thread_id?: string; content: string };
type RegenerateBody = { regenerate_message_id: string };

function isSendBody(b: unknown): b is SendBody {
  return !!b && typeof b === 'object' && 'content' in b && typeof (b as SendBody).content === 'string';
}

function isRegenerateBody(b: unknown): b is RegenerateBody {
  return (
    !!b &&
    typeof b === 'object' &&
    'regenerate_message_id' in b &&
    typeof (b as RegenerateBody).regenerate_message_id === 'string'
  );
}

const TITLE_MAX_LEN = 60;

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  let threadId: string;
  let assistantMessageId: string;

  if (isRegenerateBody(body)) {
    // Look up the message via admin client; verify ownership ourselves.
    const target = await adminDb
      .selectFrom('messages')
      .innerJoin('threads', 'threads.id', 'messages.thread_id')
      .select(['messages.id', 'messages.thread_id', 'messages.role', 'threads.user_id'])
      .where('messages.id', '=', body.regenerate_message_id)
      .executeTakeFirst();

    if (!target || target.user_id !== user.id) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    if (target.role !== 'assistant') {
      return Response.json({ error: 'only_assistant_messages_regeneratable' }, { status: 400 });
    }

    threadId = target.thread_id;

    const newAssistant = await adminDb
      .transaction()
      .execute(async (trx) => {
        await trx
          .updateTable('messages')
          .set({ superseded_at: new Date() })
          .where('id', '=', body.regenerate_message_id)
          .execute();

        const inserted = await trx
          .insertInto('messages')
          .values({ thread_id: threadId, role: 'assistant', content: '' })
          .returning(['id'])
          .executeTakeFirstOrThrow();

        await trx
          .updateTable('messages')
          .set({ superseded_by: inserted.id })
          .where('id', '=', body.regenerate_message_id)
          .execute();

        return inserted;
      });

    assistantMessageId = newAssistant.id;
  } else if (isSendBody(body)) {
    const content = body.content.trim();
    if (!content) return Response.json({ error: 'empty_content' }, { status: 400 });

    const result = await adminDb.transaction().execute(async (trx) => {
      let resolvedThreadId = body.thread_id;

      if (!resolvedThreadId) {
        const t = await trx
          .insertInto('threads')
          .values({ user_id: user.id, title: content.slice(0, TITLE_MAX_LEN) })
          .returning(['id'])
          .executeTakeFirstOrThrow();
        resolvedThreadId = t.id;
      } else {
        const owned = await trx
          .selectFrom('threads')
          .select(['id'])
          .where('id', '=', resolvedThreadId)
          .where('user_id', '=', user.id)
          .executeTakeFirst();
        if (!owned) throw new Error('thread_not_found');
      }

      await trx
        .insertInto('messages')
        .values({
          thread_id: resolvedThreadId,
          role: 'user',
          content,
          completed_at: new Date(),
        })
        .execute();

      const assistant = await trx
        .insertInto('messages')
        .values({ thread_id: resolvedThreadId, role: 'assistant', content: '' })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      return { thread_id: resolvedThreadId, assistant_message_id: assistant.id };
    });

    threadId = result.thread_id;
    assistantMessageId = result.assistant_message_id;
  } else {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  const streamId = crypto.randomUUID();

  // Open the realtime subscription BEFORE sending the event.
  const subscription = await subscribe({
    app: inngest,
    channel: chatChannel(streamId),
    topics: ['delta', 'done', 'error'],
  });

  await inngest.send({
    name: 'chat/message.requested',
    data: { streamId, threadId, assistantMessageId },
  });

  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const reader = subscription.getReader();
      try {
        while (true) {
          const { value: message, done } = await reader.read();
          if (done) break;
          if (message.topic === 'delta') {
            send('delta', message.data);
          } else if (message.topic === 'done') {
            send('done', message.data);
            break;
          } else if (message.topic === 'error') {
            send('error', message.data);
            break;
          }
        }
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : 'stream failed' });
      } finally {
        reader.releaseLock();
        await subscription.cancel().catch(() => {});
        controller.close();
      }
    },
  });

  return new Response(sse, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Stream-Id': streamId,
      'X-Thread-Id': threadId,
      'X-Assistant-Message-Id': assistantMessageId,
    },
  });
}
```

**Step 2:** Typecheck + lint.

```bash
pnpm typecheck && pnpm exec biome check .
```

Expected: both clean. There may be one or two `noNonNullAssertion` warnings or similar; resolve them inline.

**Step 3:** Commit.

```bash
git add src/app/api/chat/route.ts
git commit -m "feat(chat): /api/chat persists thread + messages, returns SSE with stream id headers"
```

---

## Phase 5 — Rewrite the Inngest function

Pull history from the DB; debounced UPDATE during streaming; final UPDATE writes telemetry.

### Task 5.1 — Update the event payload type and rewrite the function

**Files:**
- Modify: `src/lib/inngest/functions.ts`

**Step 1:** Replace the file:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { type ModelMessage, streamText } from 'ai';
import { adminDb } from '@/lib/db/admin';
import { chatChannel } from './channels';
import { inngest } from './client';

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8192;
const DEBOUNCE_MS = 250;

interface ChatRequestPayload {
  streamId: string;
  threadId: string;
  assistantMessageId: string;
}

export const chatStream = inngest.createFunction(
  {
    id: 'chat-stream',
    name: 'Chat: stream Claude response',
    triggers: [{ event: 'chat/message.requested' }],
    concurrency: { limit: 50 },
  },
  async ({ event, runId, logger }) => {
    const { streamId, threadId, assistantMessageId } = event.data as ChatRequestPayload;
    const channel = chatChannel(streamId);
    const startedAt = Date.now();

    if (!process.env.ANTHROPIC_API_KEY) {
      const message = 'ANTHROPIC_API_KEY is not configured on the server.';
      await Promise.all([
        inngest.realtime.publish(channel.error, { message }),
        adminDb
          .updateTable('messages')
          .set({
            finish_reason: 'error',
            completed_at: new Date(),
            content: '',
            inngest_run_id: runId,
            model: CLAUDE_MODEL,
          })
          .where('id', '=', assistantMessageId)
          .execute(),
      ]);
      return { ok: false as const, reason: 'missing_api_key' };
    }

    // Load active history (exclude the empty assistant placeholder).
    const rows = await adminDb
      .selectFrom('messages')
      .select(['role', 'content'])
      .where('thread_id', '=', threadId)
      .where('superseded_at', 'is', null)
      .where('id', '!=', assistantMessageId)
      .where('content', '!=', '')
      .orderBy('created_at', 'asc')
      .execute();

    const messages: ModelMessage[] = rows
      .filter((r): r is { role: 'user' | 'assistant' | 'system'; content: string } =>
        r.role === 'user' || r.role === 'assistant' || r.role === 'system',
      )
      .map((r) => ({ role: r.role, content: r.content }));

    let buffer = '';
    let lastFlushAt = 0;
    let pendingFlush: Promise<unknown> | null = null;

    const flush = async () => {
      lastFlushAt = Date.now();
      const snapshot = buffer;
      try {
        await adminDb
          .updateTable('messages')
          .set({ content: snapshot })
          .where('id', '=', assistantMessageId)
          .execute();
      } catch (err) {
        logger.warn('debounced flush failed', { err });
      }
    };

    try {
      const result = streamText({
        model: anthropic(CLAUDE_MODEL),
        maxOutputTokens: MAX_TOKENS,
        messages,
      });

      for await (const text of result.textStream) {
        if (!text) continue;
        buffer += text;
        await inngest.realtime.publish(channel.delta, { text });

        const now = Date.now();
        if (now - lastFlushAt >= DEBOUNCE_MS && !pendingFlush) {
          pendingFlush = flush().finally(() => {
            pendingFlush = null;
          });
        }
      }

      if (pendingFlush) await pendingFlush;

      const [finishReason, usage] = await Promise.all([result.finishReason, result.usage]);
      const completedAt = new Date();
      const latencyMs = completedAt.getTime() - startedAt;

      await adminDb
        .updateTable('messages')
        .set({
          content: buffer,
          completed_at: completedAt,
          finish_reason: finishReason ?? null,
          model: CLAUDE_MODEL,
          input_tokens: usage.inputTokens ?? null,
          output_tokens: usage.outputTokens ?? null,
          latency_ms: latencyMs,
          inngest_run_id: runId,
        })
        .where('id', '=', assistantMessageId)
        .execute();

      await inngest.realtime.publish(channel.done, { stopReason: finishReason ?? null });

      return {
        ok: true as const,
        stopReason: finishReason ?? null,
        outputTokens: usage.outputTokens,
        latencyMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error('chat-stream failed', { streamId, threadId, message });

      await Promise.all([
        inngest.realtime.publish(channel.error, { message }),
        adminDb
          .updateTable('messages')
          .set({
            content: buffer,
            completed_at: new Date(),
            finish_reason: 'error',
            model: CLAUDE_MODEL,
            inngest_run_id: runId,
            latency_ms: Date.now() - startedAt,
          })
          .where('id', '=', assistantMessageId)
          .execute(),
      ]);

      return { ok: false as const, reason: 'stream_error', message };
    }
  },
);

export const functions = [chatStream];
```

Notes:
- The `runId` comes from the Inngest function context (`{ event, runId, logger }` destructure). If the SDK names it differently in our version, look it up in `node_modules/inngest/components/InngestFunction.d.ts`.
- We log a warning rather than throwing if a debounced flush fails; the final UPDATE is the source of truth.
- The error path still writes whatever partial content was buffered, for forensics.

**Step 2:** Typecheck + lint.

```bash
pnpm typecheck && pnpm exec biome check .
```

If `runId` isn't in the function context type, replace `runId` in the destructure with `event.id` and update the column write accordingly.

**Step 3:** Commit.

```bash
git add src/lib/inngest/functions.ts
git commit -m "feat(chat): inngest function loads history from DB, persists deltas + telemetry"
```

---

## Phase 6 — Client (RSC + regenerate)

Move the chat page to a server component that hydrates threads + messages, add a sidebar, add a regenerate button.

### Task 6.1 — Convert `/chat` to a server component with hydration

**Files:**
- Modify: `src/app/(authed)/chat/page.tsx` (rewrite — was client-side)
- Create: `src/app/(authed)/chat/chat-view.tsx` (client component, holds the live SSE state)

**Step 1:** New page (server component):

```tsx
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ChatView } from './chat-view';

export const dynamic = 'force-dynamic';

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}) {
  const { thread: requestedThreadId } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Most recent thread (or the requested one).
  const { data: threads } = await supabase
    .from('threads')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false });

  const activeThreadId =
    requestedThreadId ?? threads?.[0]?.id ?? null;

  let messages: { id: string; role: string; content: string; superseded_at: string | null }[] = [];
  if (activeThreadId) {
    const { data } = await supabase
      .from('messages')
      .select('id, role, content, superseded_at')
      .eq('thread_id', activeThreadId)
      .is('superseded_at', null)
      .order('created_at', { ascending: true });
    messages = data ?? [];
  }

  return (
    <ChatView
      threads={threads ?? []}
      activeThreadId={activeThreadId}
      initialMessages={messages.map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant' | 'system',
        text: m.content,
      }))}
    />
  );
}
```

**Step 2:** Client component `chat-view.tsx`. Pull the existing UI from the old `chat/page.tsx`, but: (a) seed `messages` state from `initialMessages`, (b) read `X-Thread-Id` and `X-Assistant-Message-Id` from the response headers and update the URL via `router.replace(?thread=…)`, (c) include the regenerate button (Task 6.2).

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
}

interface ThreadSummary {
  id: string;
  title: string | null;
  updated_at: string;
}

interface ChatViewProps {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  initialMessages: Message[];
}

type Status = 'idle' | 'streaming' | 'error';

export function ChatView({ threads, activeThreadId, initialMessages }: ChatViewProps) {
  const router = useRouter();
  const inputId = useId();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [threadId, setThreadId] = useState<string | null>(activeThreadId);

  const consumeStream = useCallback(async (res: Response, assistantId: string) => {
    if (!res.ok || !res.body) {
      const errBody = await res.text().catch(() => '');
      throw new Error(errBody || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx === -1) break;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSseFrame(frame);
        if (!event) continue;

        if (event.event === 'delta' && typeof event.data?.text === 'string') {
          const delta = event.data.text as string;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + delta } : m)),
          );
        } else if (event.event === 'error') {
          throw new Error((event.data?.message as string) ?? 'stream error');
        }
      }
    }
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || status === 'streaming') return;

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStatus('streaming');
    setError(null);
    setInput('');

    // Optimistic local user + placeholder assistant.
    const tempUserId = `local-user-${crypto.randomUUID()}`;
    const tempAssistantId = `local-assistant-${crypto.randomUUID()}`;
    setMessages((prev) => [
      ...prev,
      { id: tempUserId, role: 'user', text },
      { id: tempAssistantId, role: 'assistant', text: '' },
    ]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: threadId, content: text }),
        signal: ctrl.signal,
      });

      const newThreadId = res.headers.get('X-Thread-Id');
      const realAssistantId = res.headers.get('X-Assistant-Message-Id');
      if (newThreadId && newThreadId !== threadId) {
        setThreadId(newThreadId);
        router.replace(`/chat?thread=${newThreadId}`);
      }
      if (realAssistantId) {
        setMessages((prev) =>
          prev.map((m) => (m.id === tempAssistantId ? { ...m, id: realAssistantId } : m)),
        );
      }

      await consumeStream(res, realAssistantId ?? tempAssistantId);
      setStatus('idle');
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      const message = err instanceof Error ? err.message : 'Stream failed';
      setError(message);
      setStatus('error');
    } finally {
      abortRef.current = null;
    }
  }, [consumeStream, input, router, status, threadId]);

  const regenerate = useCallback(
    async (assistantMessageId: string) => {
      if (status === 'streaming') return;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setStatus('streaming');
      setError(null);

      // Replace the message we're regenerating with a fresh empty placeholder.
      const tempAssistantId = `local-assistant-${crypto.randomUUID()}`;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId ? { ...m, id: tempAssistantId, text: '' } : m,
        ),
      );

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ regenerate_message_id: assistantMessageId }),
          signal: ctrl.signal,
        });
        const realAssistantId = res.headers.get('X-Assistant-Message-Id');
        if (realAssistantId) {
          setMessages((prev) =>
            prev.map((m) => (m.id === tempAssistantId ? { ...m, id: realAssistantId } : m)),
          );
        }
        await consumeStream(res, realAssistantId ?? tempAssistantId);
        setStatus('idle');
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : 'Stream failed';
        setError(message);
        setStatus('error');
      } finally {
        abortRef.current = null;
      }
    },
    [consumeStream, status],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
  }, []);

  return (
    <div className="flex flex-1">
      <aside className="hidden w-64 flex-col gap-1 border-r p-3 sm:flex">
        <h2 className="px-2 text-xs font-medium uppercase text-muted-foreground">Threads</h2>
        {threads.length === 0 && (
          <p className="px-2 text-sm text-muted-foreground">No threads yet.</p>
        )}
        {threads.map((t) => (
          <a
            key={t.id}
            href={`/chat?thread=${t.id}`}
            className={`truncate rounded-md px-2 py-1.5 text-sm hover:bg-muted ${
              t.id === threadId ? 'bg-muted font-medium' : ''
            }`}
          >
            {t.title ?? 'Untitled'}
          </a>
        ))}
      </aside>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
        <header className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold">Chat</h1>
          <span className="text-xs text-muted-foreground">claude-sonnet-4-6 · via Inngest</span>
        </header>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto rounded-lg border p-4">
          {messages.length === 0 && (
            <p className="text-sm text-muted-foreground">Say hello to start.</p>
          )}
          {messages.map((m) => (
            <div key={m.id} className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{m.role}</span>
                {m.role === 'assistant' && !m.id.startsWith('local-') && status === 'idle' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => regenerate(m.id)}
                  >
                    Regenerate
                  </Button>
                )}
              </div>
              <div className="whitespace-pre-wrap text-sm">
                {m.text || (m.role === 'assistant' && status === 'streaming' ? '…' : '')}
              </div>
            </div>
          ))}
          {error && <p className="text-sm text-destructive">Error: {error}</p>}
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            Message
          </label>
          <input
            id={inputId}
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            placeholder="Type a message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={status === 'streaming'}
          />
          {status === 'streaming' ? (
            <Button type="button" variant="outline" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim()}>
              Send
            </Button>
          )}
        </form>
      </main>
    </div>
  );
}

function parseSseFrame(frame: string): { event: string; data: Record<string, unknown> } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
  } catch {
    return null;
  }
}
```

**Step 3:** Typecheck + lint.

```bash
pnpm typecheck && pnpm exec biome check .
```

Expected: both clean. Resolve any unused imports / lint warnings.

**Step 4:** Commit.

```bash
git add "src/app/(authed)/chat/"
git commit -m "feat(chat): RSC hydration + regenerate button + thread sidebar"
```

---

## Phase 7 — Stuck-stream cron

### Task 7.1 — Add the timeout cleanup function and register it

**Files:**
- Modify: `src/lib/inngest/functions.ts`

**Step 1:** Append a second function in the same file. Inngest cron triggers use `cron: '*/5 * * * *'` syntax.

```ts
export const chatStreamTimeoutCleanup = inngest.createFunction(
  {
    id: 'chat-stream-timeout-cleanup',
    name: 'Chat: mark stuck streams as timed out',
  },
  { cron: '*/5 * * * *' },
  async ({ logger }) => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const updated = await adminDb
      .updateTable('messages')
      .set({ finish_reason: 'timeout', completed_at: new Date() })
      .where('completed_at', 'is', null)
      .where('created_at', '<', fiveMinAgo)
      .where('role', '=', 'assistant')
      .returning(['id'])
      .execute();
    if (updated.length > 0) {
      logger.info('marked stuck assistant messages as timed out', { count: updated.length });
    }
    return { count: updated.length };
  },
);
```

**Step 2:** Update the exported `functions` array:

```ts
export const functions = [chatStream, chatStreamTimeoutCleanup];
```

**Step 3:** Verify by booting `pnpm dev` and curling `/api/inngest`:

```bash
INNGEST_DEV=1 pnpm dev > /tmp/devstuck.log 2>&1 &
sleep 8
curl -s http://localhost:3000/api/inngest
```

Expected: `function_count: 2`. Kill the dev server.

**Step 4:** Typecheck + lint + commit.

```bash
pnpm typecheck && pnpm exec biome check .
git add src/lib/inngest/functions.ts
git commit -m "feat(chat): add cron to mark stuck assistant messages as timed out"
```

---

## Phase 8 — End-to-end verification

### Task 8.1 — Manual flow with a real OAuth login

**Step 1:** Set up `.env.local` (you'll need real OAuth credentials):

```bash
cp .env.example .env.local
# Fill in:
#   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY (from `pnpm db:start` output)
#   SUPABASE_DB_URL (printed above)
#   SUPABASE_SERVICE_ROLE_KEY (printed above)
#   ANTHROPIC_API_KEY (real key)
#   INNGEST_DEV=1
#   SUPABASE_AUTH_GITHUB_CLIENT_ID + SUPABASE_AUTH_GITHUB_SECRET (from a GitHub OAuth app)
```

GitHub OAuth app: https://github.com/settings/developers → New OAuth app, callback `http://127.0.0.1:54321/auth/v1/callback`.

**Step 2:** `pnpm dev`. Open `http://localhost:3000/chat`.

Expected: redirected to `/login`. Click "Continue with GitHub". Complete the OAuth flow. Land on `/chat`.

**Step 3:** Send a message. Expect: streaming text fills in. URL updates to `/chat?thread=<uuid>`. Sidebar shows the new thread.

**Step 4:** Verify rows in DB.

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select id, title from public.threads;"
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select role, length(content), finish_reason, output_tokens, latency_ms from public.messages order by created_at;"
```

Expected: one thread (title = first 60 chars of message), one user message (`completed_at` set), one assistant message (`finish_reason='stop'`, telemetry populated).

**Step 5:** Click "Regenerate" on the assistant message. Expect: text empties, then refills with a new response. DB shows the old assistant row with `superseded_at` set + `superseded_by` pointing at a new row.

**Step 6:** Sign out → confirm redirected to `/login`.

**Step 7:** Reload the chat page. Confirm thread + messages re-hydrate from the DB.

No commit — this is verification, not code.

---

### Task 8.2 — Final checks before opening a PR

```bash
pnpm typecheck
pnpm exec biome check .
pnpm test
pnpm build
```

All four should pass clean. If any fail, fix and commit before continuing.

---

## What this plan deliberately doesn't cover

- LLM-generated thread titles (we truncate; smarter titles are a follow-up)
- Mid-stream live resume across reloads
- A `profiles` table
- Thread soft-delete, search, exports, tags
- Anonymous auth
- Multi-org / workspaces
- A separate evals UI on top of the run telemetry

All listed in the design doc's "Out of scope" section. Do not extend this plan with any of them without re-running the brainstorming step.
