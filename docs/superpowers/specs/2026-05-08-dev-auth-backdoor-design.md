# Dev auth backdoor — design

## Problem

OAuth-only sign-in (GitHub/Google) is inconvenient for local development and unworkable for headless E2E tests. We need a local-only way to sign in as an arbitrary email with no provider round trip.

## Goals

- One-click email-only sign-in on `/login` during local development.
- A scriptable HTTP endpoint usable by Playwright (or any test runner) to mint a session without a browser redirect through Supabase.
- Hard gate that prevents the feature from ever activating in production, independent of `NODE_ENV`.

## Non-goals

- A general-purpose impersonation feature for staging or production.
- Email/password sign-in for real users.
- Any change to OAuth flows.
- Authoring the Playwright fixture itself (this spec adds the endpoint the fixture will call; the fixture is a follow-up).

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Surface | UI form on `/login` **and** HTTP endpoint | Convenience for humans, scriptability for E2E. |
| Gate | Single env var `DEV_AUTH_ENABLED=1` | `NODE_ENV` is unreliable — sometimes prod-built apps run for local perf testing. Explicit opt-in. |
| Missing user behaviour | Auto-create | Disposable emails per E2E run; the gate is the safety net. |
| Session-minting mechanism | Server-side magic-link verify | One round trip, no Supabase redirect, headless-friendly, indistinguishable from a real session. |

## Architecture

A new Route Handler (`POST /api/dev/login`) is the only entry point. The `/login` page conditionally renders a small client component that calls the endpoint. Both are gated by the same server-side env check.

```
Browser (form)            Route Handler                Supabase
    │                          │                          │
    │ POST /api/dev/login      │                          │
    │ { email, next }          │                          │
    ├─────────────────────────▶│                          │
    │                          │ admin.createUser         │
    │                          │  (ignore if exists)      │
    │                          ├─────────────────────────▶│
    │                          │ admin.generateLink       │
    │                          │  → hashed_token          │
    │                          ├─────────────────────────▶│
    │                          │ verifyOtp(hashed_token)  │
    │                          │  via user-context client │
    │                          │  → writes cookies        │
    │                          ├─────────────────────────▶│
    │ 200 { ok, next }         │                          │
    │ Set-Cookie: sb-…         │                          │
    │◀─────────────────────────┤                          │
    │ router.push(next)        │                          │
```

For E2E, the same endpoint is invoked directly by the test (no UI step). After the response, the test navigates to a protected route; cookies are already set.

## Components

### `POST /api/dev/login` — `src/app/api/dev/login/route.ts`

Server-only Route Handler. The single entry point for backdoor sign-in.

**Request body** (Zod):

```ts
{
  email: z.string().email(),
  next: z.string().regex(/^\/(?!\/)/).optional()
}
```

The `next` regex enforces a leading slash that is not `//` to block open-redirect attempts, mirroring the sanitisation already in `src/app/auth/callback/route.ts`.

**Behaviour:**

1. If `env.DEV_AUTH_ENABLED !== '1'`, return `404 { error: 'not_found' }` immediately. Do not touch Supabase. The 404 hides the route's existence.
2. Parse the body; on failure, return `400 { error: 'invalid_request', details }`.
3. Construct the admin client (`createAdminClient()`).
4. `admin.auth.admin.createUser({ email, email_confirm: true })`. If the response error indicates the user already exists (Supabase returns a recognisable code/message), continue silently. Any other error → `500`.
5. `admin.auth.admin.generateLink({ type: 'magiclink', email })`. Extract `properties.hashed_token`. On error → `500`.
6. Construct the user-context server client (`createClient()` from `src/lib/supabase/server.ts`).
7. `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })`. The cookie adapter writes the session cookies onto the response. On error → `500`. (If the installed `@supabase/supabase-js` version uses `'email'` instead of the deprecated `'magiclink'` for magic-link verification, the implementation should match the installed type definition.)
8. Return `200 { ok: true, next: next ?? '/chat' }`.

**Why this works without an email round trip:** `generateLink` returns the same `hashed_token` that Supabase would put inside an emailed magic link. Calling `verifyOtp` with that token mints a session exactly as if the user had clicked through.

### `createAdminClient()` — `src/lib/supabase/admin.ts` (new)

Returns a `@supabase/supabase-js` client constructed with `process.env.SUPABASE_SERVICE_ROLE_KEY`. No cookie adapter — admin operations do not write user cookies. Server-only; never imported from `'use client'`. Parallels the existing `src/lib/db/admin.ts` (Kysely service-role client).

### `<DevSignIn />` — `src/app/login/dev-sign-in.tsx` (new client component)

Email input + submit button. Uses `useTransition` and `fetch` per the project's "REST + fetch" convention.

```tsx
'use client';
// email state, error state, useTransition
// onSubmit: fetch('/api/dev/login', { method:'POST', headers, body: JSON.stringify({ email }) })
//   ok → router.push(json.next); router.refresh()
//   not ok → setError(json.error ?? 'failed')
```

Renders an inline error in the same destructive-styled block as the existing `/login` error display.

### `/login` page — `src/app/login/page.tsx` (edit)

Reads `env.DEV_AUTH_ENABLED` (server component, no client exposure) and renders `<DevSignIn />` only when the gate is on. Visually separated from the OAuth buttons by a divider and a small "Local dev sign-in" heading.

### `env.DEV_AUTH_ENABLED` — `src/lib/env.ts` (edit)

Add to the server Zod schema:

```ts
DEV_AUTH_ENABLED: z.literal('1').optional()
```

Documented in `.env.example` with an explicit warning never to set it in production.

## Data flow (success path)

1. User types `alice@example.com` on `/login`, clicks submit.
2. Client component POSTs `{ email: 'alice@example.com' }` to `/api/dev/login`.
3. Route handler: gate ok → admin createUser (or no-op if exists) → admin generateLink → server-client verifyOtp.
4. Response has `Set-Cookie: sb-...` headers and JSON `{ ok: true, next: '/chat' }`.
5. Client calls `router.push('/chat')` and `router.refresh()`.
6. `src/middleware.ts` refreshes the session on the next request.
7. `src/app/(authed)/layout.tsx` finds a valid session and renders `/chat`.

## Error handling

| Case | Status | Body |
|---|---|---|
| Gate off | 404 | `{ error: 'not_found' }` |
| Invalid body (bad email, malformed `next`) | 400 | `{ error: 'invalid_request', details }` |
| `createUser` fails (non-duplicate reason) | 500 | `{ error: <message> }` |
| `generateLink` fails | 500 | `{ error: <message> }` |
| `verifyOtp` fails | 500 | `{ error: <message> }` |
| Success | 200 | `{ ok: true, next }` |

Sanitisation = use the Supabase error's `.message` string only; do not echo the full error object. The gate keeps this surface off production, so leaking Supabase internals locally is acceptable.

## Safety properties

- **Production-safe by construction.** With no `DEV_AUTH_ENABLED` env var set, the route returns 404 before constructing any client, and the UI section does not render. There is no client-side feature flag to flip.
- **Service-role key stays server-side.** The new `createAdminClient` lives next to the existing server Supabase helper and is never imported from a `'use client'` file. Same convention as `src/lib/db/admin.ts`.
- **No magic-link leakage.** The `hashed_token` never reaches the browser; it is consumed in the same request that generated it.
- **Open-redirect closed.** The `next` parameter is validated to be a single-leading-slash relative path, matching `src/app/auth/callback/route.ts`.

## Testing

Vitest unit tests in `src/app/api/dev/login/route.test.ts` covering:

- Gate off → 404, and admin/server clients are never constructed (assert via `vi.mock` spies).
- Invalid email → 400.
- `next` of `//evil.com`, `http://evil.com`, or `\\evil.com` → 400.
- New email → `createUser` called with `email_confirm: true`, `verifyOtp` called with the `hashed_token` from `generateLink`, response is 200.
- Existing email (`createUser` returns the "already registered" error) → no thrown error, `verifyOtp` still runs, response is 200.
- `generateLink` failure → 500 with sanitised message.

Both Supabase clients are mocked via `vi.mock`. The route is server-side; happy-dom is unused.

Manual smoke test: `DEV_AUTH_ENABLED=1 pnpm dev`, open `/login`, submit an arbitrary email, land on `/chat`.

## Files

- New: `src/app/api/dev/login/route.ts`
- New: `src/app/api/dev/login/route.test.ts`
- New: `src/lib/supabase/admin.ts`
- New: `src/app/login/dev-sign-in.tsx`
- Edit: `src/app/login/page.tsx`
- Edit: `src/lib/env.ts`
- Edit: `.env.example`
- Edit: `CLAUDE.md` (brief mention under Environment / Conventions)

## Future work (out of scope here)

- Playwright auth fixture that POSTs to the endpoint and persists `storageState` per worker.
- Optional: a small CLI helper (`pnpm dev:login some@email`) for terminal-driven dev sign-in.
