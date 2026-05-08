# Dev Auth Backdoor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only email-based sign-in flow (UI + HTTP endpoint) so developers and Playwright tests can authenticate without an OAuth round trip, gated by `DEV_AUTH_ENABLED=1`.

**Architecture:** A new `POST /api/dev/login` Route Handler is the single entry point. It (1) ensures the user exists via the Supabase admin API, (2) generates a magic-link `hashed_token`, and (3) calls `verifyOtp` through the cookie-bound server client to mint a session in one round trip — no email, no Supabase redirect. A small client component on `/login` posts to that endpoint; both the endpoint and the UI section are gated server-side by `env.DEV_AUTH_ENABLED === '1'`. When the gate is off, the endpoint returns 404 and the UI section does not render.

**Tech Stack:** Next.js 16 (App Router), `@supabase/supabase-js` v2, `@supabase/ssr`, Zod, Vitest, Biome, Tailwind v4, ShadCN.

**Spec:** [`docs/superpowers/specs/2026-05-08-dev-auth-backdoor-design.md`](../specs/2026-05-08-dev-auth-backdoor-design.md)

---

## File map

| Path | Purpose | Status |
|---|---|---|
| `src/lib/env.ts` | Add `DEV_AUTH_ENABLED` to server schema | Modify |
| `.env.example` | Document the new env var | Modify |
| `src/lib/supabase/admin.ts` | Service-role Supabase JS client (no cookies) | Create |
| `src/app/api/dev/login/route.ts` | Gated `POST` route — ensures user, mints session | Create |
| `src/app/api/dev/login/route.test.ts` | Unit tests for the route | Create |
| `src/app/login/dev-sign-in.tsx` | Client component — email form posting to the route | Create |
| `src/app/login/page.tsx` | Conditionally render `<DevSignIn />` when gate is on | Modify |
| `CLAUDE.md` | Brief mention under Environment | Modify |

Each task below produces a coherent, independently committable change. TDD red→green→refactor happens **inside** Task 2 (the route handler), since that's where there's logic worth driving with tests.

---

### Task 0: Wire env var and document it

**Goal:** `DEV_AUTH_ENABLED` exists in the validated env schema and in `.env.example`, with a clear warning about production.

**Files:**
- Modify: `src/lib/env.ts`
- Modify: `.env.example`
- Modify: `CLAUDE.md`

**Acceptance Criteria:**
- [ ] `env.DEV_AUTH_ENABLED` is typed as `'1' | undefined` after parsing.
- [ ] `pnpm typecheck` passes.
- [ ] `.env.example` documents the var with a "never set in production" warning.
- [ ] `CLAUDE.md` Environment section mentions the var.

**Verify:** `pnpm typecheck` → no errors

**Steps:**

- [ ] **Step 1: Add `DEV_AUTH_ENABLED` to the server Zod schema**

In `src/lib/env.ts`, extend `serverSchema`:

```ts
const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_DB_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  INNGEST_EVENT_KEY: z.string().min(1).optional(),
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  SUPABASE_AUTH_GITHUB_CLIENT_ID: z.string().min(1).optional(),
  SUPABASE_AUTH_GITHUB_SECRET: z.string().min(1).optional(),
  SUPABASE_AUTH_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  SUPABASE_AUTH_GOOGLE_SECRET: z.string().min(1).optional(),
  // Local-dev only: enables /api/dev/login backdoor. Never set in production.
  DEV_AUTH_ENABLED: z.literal('1').optional(),
});
```

- [ ] **Step 2: Document the var in `.env.example`**

Append a new section to `.env.example`:

```
# --- Local dev auth backdoor ---
# Set to "1" ONLY for local development or E2E. When enabled, exposes
# /api/dev/login which accepts an email and mints a session without OAuth.
# NEVER set this in any deployed environment.
DEV_AUTH_ENABLED=""
```

- [ ] **Step 3: Mention in `CLAUDE.md`**

In the Environment section of `CLAUDE.md`, add a bullet to the env list:

```
- `DEV_AUTH_ENABLED=1` (optional) — exposes a local-only email sign-in at
  `/api/dev/login` and a "Local dev sign-in" form on `/login`. Never set in
  deployed environments.
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm typecheck
```

Expected: no errors.

```bash
git add src/lib/env.ts .env.example CLAUDE.md
git commit -m "Add DEV_AUTH_ENABLED env var for local dev sign-in"
```

---

### Task 1: Supabase service-role client

**Goal:** A reusable service-role Supabase JS client at `src/lib/supabase/admin.ts`, mirroring the conventions of `src/lib/db/admin.ts` (server-only, throws if env missing, cached on `globalThis` in non-prod).

**Files:**
- Create: `src/lib/supabase/admin.ts`

**Acceptance Criteria:**
- [ ] Exports `createAdminClient()` returning a `SupabaseClient<Database>` constructed with `SUPABASE_SERVICE_ROLE_KEY`.
- [ ] Imports `'server-only'` to fail loudly on accidental client import.
- [ ] Throws a clear error if `SUPABASE_SERVICE_ROLE_KEY` or `NEXT_PUBLIC_SUPABASE_URL` is missing.
- [ ] No cookie adapter (admin operations don't write user cookies).
- [ ] `pnpm typecheck` and `pnpm lint` pass.

**Verify:** `pnpm typecheck && pnpm lint` → no errors

**Steps:**

- [ ] **Step 1: Create the admin client module**

Write `src/lib/supabase/admin.ts`:

```ts
import 'server-only';

import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/db/database.types';

/**
 * Service-role Supabase JS client. Bypasses RLS. Only import from server
 * code that has either (a) already validated user ownership upstream, or
 * (b) is itself gated by an env flag that disables it in production
 * (see `src/app/api/dev/login/route.ts`).
 *
 * Never import from a `'use client'` file.
 */
export function createAdminClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set.');
  }
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set.');
  }

  return createClient<Database>(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
```

Notes:
- `autoRefreshToken: false` and `persistSession: false` keep the client stateless — appropriate for short-lived per-request admin operations.
- We intentionally do **not** memoise on `globalThis` like `lib/db/admin.ts` does. The Supabase JS client is cheap to construct, and creating fresh per request avoids surprising shared state across concurrent requests.

- [ ] **Step 2: Verify and commit**

Run:

```bash
pnpm typecheck && pnpm lint
```

Expected: no errors.

```bash
git add src/lib/supabase/admin.ts
git commit -m "Add service-role Supabase JS client helper"
```

---

### Task 2: `POST /api/dev/login` route handler with tests

**Goal:** A Route Handler that, when gated on, ensures the user exists, generates a magic-link `hashed_token`, and verifies it through the cookie-bound server client to set session cookies on the response. Drive the implementation with tests — this is the only task with non-trivial logic.

**Files:**
- Create: `src/app/api/dev/login/route.ts`
- Create: `src/app/api/dev/login/route.test.ts`

**Acceptance Criteria:**
- [ ] Returns 404 with `{ error: 'not_found' }` when `DEV_AUTH_ENABLED !== '1'`.
- [ ] Returns 400 on invalid body (bad email, malformed/absolute `next`).
- [ ] On success: calls `admin.auth.admin.createUser({ email, email_confirm: true })`; if the response error indicates the user already exists, swallows it.
- [ ] Calls `admin.auth.admin.generateLink({ type: 'magiclink', email })` and uses `properties.hashed_token`.
- [ ] Calls `serverClient.auth.verifyOtp` with the hashed token (using whichever `type` value the installed `@supabase/supabase-js` version requires for magic-link tokens — check the type definition; in v2.105.x it is `'email'`, in older versions it was `'magiclink'`).
- [ ] When gate is off, neither `createAdminClient()` nor `createClient()` (server) is invoked.
- [ ] Open-redirect defence: `next` must match `/^\/(?!\/)/`.
- [ ] All test cases below pass.

**Verify:** `pnpm test src/app/api/dev/login/route.test.ts` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/dev/login/route.test.ts`:

```ts
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks must be declared before the route is imported.
const adminCreateUser = vi.fn();
const adminGenerateLink = vi.fn();
const verifyOtp = vi.fn();
const createAdminClient = vi.fn(() => ({
  auth: {
    admin: {
      createUser: adminCreateUser,
      generateLink: adminGenerateLink,
    },
  },
}));
const createServerClient = vi.fn(async () => ({
  auth: {
    verifyOtp,
  },
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: createServerClient,
}));

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/dev/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/dev/login', () => {
  const originalFlag = process.env.DEV_AUTH_ENABLED;

  beforeEach(() => {
    process.env.DEV_AUTH_ENABLED = '1';
    adminCreateUser.mockReset();
    adminGenerateLink.mockReset();
    verifyOtp.mockReset();
    createAdminClient.mockClear();
    createServerClient.mockClear();
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.DEV_AUTH_ENABLED;
    } else {
      process.env.DEV_AUTH_ENABLED = originalFlag;
    }
  });

  it('returns 404 and never touches Supabase when gate is off', async () => {
    delete process.env.DEV_AUTH_ENABLED;
    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'a@example.com' }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('returns 400 when body fails validation', async () => {
    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'not-an-email' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
  });

  it.each([['//evil.com'], ['http://evil.com'], ['evil.com'], ['\\evil.com']])(
    'returns 400 when next=%s is not a safe relative path',
    async (next) => {
      const { POST } = await import('./route');

      const res = await POST(postRequest({ email: 'a@example.com', next }));

      expect(res.status).toBe(400);
    },
  );

  it('creates user, generates link, verifies otp, and returns next', async () => {
    adminCreateUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    adminGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'tok-abc' } },
      error: null,
    });
    verifyOtp.mockResolvedValue({ data: {}, error: null });

    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'alice@example.com', next: '/chat' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, next: '/chat' });

    expect(adminCreateUser).toHaveBeenCalledWith({
      email: 'alice@example.com',
      email_confirm: true,
    });
    expect(adminGenerateLink).toHaveBeenCalledWith({
      type: 'magiclink',
      email: 'alice@example.com',
    });
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    const verifyArg = verifyOtp.mock.calls[0]?.[0];
    expect(verifyArg).toMatchObject({ token_hash: 'tok-abc' });
  });

  it('defaults next to /chat when omitted', async () => {
    adminCreateUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    adminGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'tok' } },
      error: null,
    });
    verifyOtp.mockResolvedValue({ data: {}, error: null });

    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'bob@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, next: '/chat' });
  });

  it('swallows "already registered" createUser error and still verifies', async () => {
    adminCreateUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'A user with this email address has already been registered', status: 422 },
    });
    adminGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'tok' } },
      error: null,
    });
    verifyOtp.mockResolvedValue({ data: {}, error: null });

    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'existing@example.com' }));

    expect(res.status).toBe(200);
    expect(verifyOtp).toHaveBeenCalled();
  });

  it('returns 500 when createUser fails for an unrelated reason', async () => {
    adminCreateUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'boom', status: 500 },
    });

    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'a@example.com' }));

    expect(res.status).toBe(500);
    expect(adminGenerateLink).not.toHaveBeenCalled();
  });

  it('returns 500 when generateLink fails', async () => {
    adminCreateUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    adminGenerateLink.mockResolvedValue({
      data: null,
      error: { message: 'link failed' },
    });

    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'a@example.com' }));

    expect(res.status).toBe(500);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('returns 500 when verifyOtp fails', async () => {
    adminCreateUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    adminGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'tok' } },
      error: null,
    });
    verifyOtp.mockResolvedValue({ data: null, error: { message: 'verify failed' } });

    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'a@example.com' }));

    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/app/api/dev/login/route.test.ts
```

Expected: all tests fail with module-not-found for `./route`.

- [ ] **Step 3: Implement the route handler**

Create `src/app/api/dev/login/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient as createServerSupabase } from '@/lib/supabase/server';

const bodySchema = z.object({
  email: z.string().email(),
  // Mirrors the sanitisation in src/app/auth/callback/route.ts:
  // single leading slash, not "//" (open-redirect protection).
  next: z
    .string()
    .regex(/^\/(?!\/)/)
    .optional(),
});

const ALREADY_REGISTERED_PATTERNS = [
  /already.*registered/i,
  /already exists/i,
  /user_already_exists/i,
];

function isAlreadyRegistered(error: { message?: string } | null | undefined): boolean {
  if (!error?.message) return false;
  return ALREADY_REGISTERED_PATTERNS.some((p) => p.test(error.message ?? ''));
}

export async function POST(req: Request): Promise<Response> {
  if (process.env.DEV_AUTH_ENABLED !== '1') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { email } = parsed.data;
  const next = parsed.data.next ?? '/chat';

  const admin = createAdminClient();

  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error && !isAlreadyRegistered(created.error)) {
    return NextResponse.json({ error: created.error.message }, { status: 500 });
  }

  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (link.error || !link.data?.properties?.hashed_token) {
    return NextResponse.json(
      { error: link.error?.message ?? 'generate_link_failed' },
      { status: 500 },
    );
  }
  const tokenHash = link.data.properties.hashed_token;

  const supabase = await createServerSupabase();
  // The verifyOtp `type` for a magic-link token_hash. In @supabase/supabase-js
  // v2.105.x this is `'email'`; older versions used `'magiclink'`. If
  // typecheck rejects this literal, switch to whichever the installed type
  // definition allows.
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: 'email',
    token_hash: tokenHash,
  });
  if (verifyError) {
    return NextResponse.json({ error: verifyError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, next });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test src/app/api/dev/login/route.test.ts
```

Expected: all tests pass.

If a test fails because the test mock argument used `'magiclink'` while implementation passes `'email'` to `verifyOtp`, the test only asserts `token_hash`, not `type`, so it should pass either way. If you need to change the `type` literal due to type-checker pushback, do so in **both** the implementation and the test in lock-step.

- [ ] **Step 5: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/dev/login/route.ts src/app/api/dev/login/route.test.ts
git commit -m "Add /api/dev/login route handler with tests"
```

---

### Task 3: `<DevSignIn />` client component

**Goal:** A small client component that renders an email input + submit button, posts to `/api/dev/login`, and on success navigates to the returned `next` path.

**Files:**
- Create: `src/app/login/dev-sign-in.tsx`

**Acceptance Criteria:**
- [ ] `'use client'` component, default export.
- [ ] Email input is typed `email`, required, and bound to local state.
- [ ] Uses `useTransition` while the request is in flight; button is disabled and shows pending text.
- [ ] On `200`, calls `router.push(json.next)` and `router.refresh()`.
- [ ] On non-200, shows the error string in the same destructive-styled block used on `/login` for OAuth errors.
- [ ] Tailwind classes match the surrounding `/login` page conventions.
- [ ] `pnpm typecheck` and `pnpm lint` pass.

**Verify:** `pnpm typecheck && pnpm lint` → no errors

**Steps:**

- [ ] **Step 1: Create the component**

Write `src/app/login/dev-sign-in.tsx`:

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';

export default function DevSignIn() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/dev/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; next?: string; error?: string }
          | null;
        if (!res.ok || !json?.ok) {
          setError(json?.error ?? `request_failed_${res.status}`);
          return;
        }
        router.push(json.next ?? '/chat');
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'request_failed');
      }
    });
  }

  return (
    <div className="flex w-full flex-col gap-3 border-t border-border pt-6">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        Local dev sign-in
      </p>
      {error && (
        <p className="w-full rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <form className="flex w-full flex-col gap-2" onSubmit={onSubmit}>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
          }}
          placeholder="you@example.com"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button type="submit" variant="secondary" className="w-full" disabled={isPending}>
          {isPending ? 'Signing in…' : 'Dev sign-in'}
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Verify and commit**

```bash
pnpm typecheck && pnpm lint
```

Expected: no errors.

```bash
git add src/app/login/dev-sign-in.tsx
git commit -m "Add DevSignIn client component"
```

---

### Task 4: Wire DevSignIn into `/login` page

**Goal:** `/login` server component conditionally renders `<DevSignIn />` when the gate is on. No client-side env exposure.

**Files:**
- Modify: `src/app/login/page.tsx`

**Acceptance Criteria:**
- [ ] When `env.DEV_AUTH_ENABLED === '1'`, the dev section renders below the OAuth buttons.
- [ ] When the flag is unset, the page renders exactly as before (only OAuth buttons).
- [ ] No `'use client'` added at the page level.
- [ ] `env` is read from `@/lib/env`, not `process.env` directly.
- [ ] `pnpm typecheck` and `pnpm lint` pass.

**Verify:**
1. `pnpm typecheck && pnpm lint` → no errors
2. With `DEV_AUTH_ENABLED=1` set, visit `/login` and confirm the section renders. With it unset, confirm it does not. (Manual smoke deferred to Task 5; here just check the conditional compiles.)

**Steps:**

- [ ] **Step 1: Update `src/app/login/page.tsx`**

Replace the file contents with:

```tsx
import { Button } from '@/components/ui/button';
import { env } from '@/lib/env';
import DevSignIn from './dev-sign-in';
import { signInWithGitHub, signInWithGoogle } from './actions';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const devAuthEnabled = env.DEV_AUTH_ENABLED === '1';

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

      {devAuthEnabled && <DevSignIn />}
    </main>
  );
}
```

- [ ] **Step 2: Verify and commit**

```bash
pnpm typecheck && pnpm lint
```

Expected: no errors.

```bash
git add src/app/login/page.tsx
git commit -m "Conditionally render DevSignIn on /login when gate is on"
```

---

### Task 5: Manual smoke + final verification

**Goal:** Confirm the end-to-end flow works against a real local Supabase and that the gate truly disables it.

**Files:**
- (None — verification only)

**Acceptance Criteria:**
- [ ] With `DEV_AUTH_ENABLED=1`, submitting an email on `/login` lands on `/chat` as that user.
- [ ] With the flag unset, `/login` renders only the OAuth buttons and `POST /api/dev/login` returns 404.
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint` all pass.

**Verify:**
1. `pnpm test && pnpm typecheck && pnpm lint`
2. Manual smoke: see steps below.

**Steps:**

- [ ] **Step 1: Ensure local Supabase is running**

```bash
pnpm db:start
```

If env vars are stale, copy fresh anon and service-role keys from the output into `.env.local`.

- [ ] **Step 2: Run the gated-on smoke test**

In one terminal:

```bash
DEV_AUTH_ENABLED=1 pnpm dev
```

In a browser, open `http://localhost:3000/login`. Confirm the "Local dev sign-in" section renders. Enter `smoke-$(date +%s)@example.com`, click "Dev sign-in", and confirm the page navigates to `/chat`.

In another terminal, hit the endpoint directly to confirm the headless path:

```bash
curl -i -c /tmp/dawn-cookies.txt \
  -H 'content-type: application/json' \
  -d '{"email":"curl-smoke@example.com"}' \
  http://localhost:3000/api/dev/login
```

Expected: `HTTP/1.1 200 OK`, body `{"ok":true,"next":"/chat"}`, and `Set-Cookie:` headers for `sb-...` cookies.

- [ ] **Step 3: Run the gated-off smoke test**

Stop the dev server. Restart it without the flag:

```bash
pnpm dev
```

Visit `/login` and confirm the dev section is gone.

```bash
curl -i -X POST -H 'content-type: application/json' \
  -d '{"email":"a@b.com"}' \
  http://localhost:3000/api/dev/login
```

Expected: `HTTP/1.1 404 Not Found`, body `{"error":"not_found"}`.

- [ ] **Step 4: Final test/lint sweep**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all pass.

- [ ] **Step 5: Commit (if any docs touched during smoke; otherwise skip)**

If you tweaked CLAUDE.md or README during smoke testing, commit those changes:

```bash
git status
# if there are changes:
git add -A
git commit -m "Doc tweaks from dev-auth smoke testing"
```

---

## Self-review notes

- **Spec coverage:** every section of the design spec maps to a task — env (Task 0), admin client (Task 1), endpoint contract + safety + tests (Task 2), UI component (Task 3), page integration (Task 4), end-to-end smoke (Task 5).
- **`verifyOtp` type literal:** the spec flagged this ambiguity. Task 2 instructs the implementer to default to `'email'` (current SDK) and switch if typecheck disagrees. Tests assert only `token_hash`, so they pass either way.
- **No placeholders:** every step has either runnable code, an exact command, or an exact expected output.
- **Commit cadence:** five commits across five tasks, each independently revertible.
