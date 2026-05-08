# dawn

A Next.js + Supabase + Inngest template with Anthropic-powered chat. See
[CLAUDE.md](CLAUDE.md) for the full stack overview and conventions.

## Getting Started

After cloning, run the bootstrap script first to rename the project (slug,
display name, Inngest app id, Supabase `project_id`, page titles, `CLAUDE.md`):

```bash
pnpm bootstrap
pnpm install
```

Then copy and fill in environment variables:

```bash
cp .env.example .env.local
```

Required env vars (see [CLAUDE.md](CLAUDE.md#environment) for the full list):

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`
- GitHub OAuth keys (`SUPABASE_AUTH_GITHUB_CLIENT_ID` + `SUPABASE_AUTH_GITHUB_SECRET`)
- `INNGEST_DEV=1` for local dev

`pnpm db:start` prints fresh values for the Supabase keys.

## Run

```bash
pnpm db:start   # boots local Supabase (Docker)
pnpm dev        # generate → next dev (Turbopack) + Inngest dev server
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Script            | Purpose                                              |
| ----------------- | ---------------------------------------------------- |
| `pnpm dev`        | Full dev: codegen, Next.js, and Inngest concurrently |
| `pnpm build`      | `prebuild` codegen, then `next build`                |
| `pnpm generate`   | Run all codegen once (Supabase types)                |
| `pnpm bootstrap`  | Rename the template to your project                  |
| `pnpm db:start`   | `supabase start` (Docker)                            |
| `pnpm db:stop`    | `supabase stop`                                      |
| `pnpm db:reset`   | Re-apply migrations + seed                           |
| `pnpm typecheck`  | `tsc --noEmit`                                       |
| `pnpm lint`       | `biome check .`                                      |
| `pnpm lint:fix`   | `biome check --write .`                              |
| `pnpm format`     | `biome format --write .`                             |
| `pnpm test`       | `vitest run`                                         |
| `pnpm test:watch` | `vitest`                                             |

## Stack

- Next.js (App Router, RSC, Turbopack), React 19, TypeScript (strict)
- Tailwind CSS v4, ShadCN UI (`new-york`/`neutral`)
- Supabase (Postgres + Auth), Kysely query builder
- Inngest for background jobs and chat streaming
- Vercel `ai` + `@ai-sdk/anthropic` (`claude-sonnet-4-6`)
- Biome (lint + format), Vitest + Testing Library + happy-dom

## Deploy

Easiest path: [Vercel](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme).
You'll need a hosted Supabase project, an Inngest app, and the env vars above
configured in the platform.
