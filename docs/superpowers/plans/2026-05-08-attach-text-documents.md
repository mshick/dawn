# Attach text documents to a conversation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end happy path for attaching PDF/DOCX/MD/TXT documents to a conversation, indexing them in an Inngest pipeline, and exposing three retrieval tools to the chat agent.

**Architecture:** A new `documentIngest` Inngest function runs `extract → chunk → embed → index` on uploaded files; chunks land in a new `chunks` table with pgvector + tsvector indexes. `chatStream` exposes hybrid-search / neighbor / metadata tools scoped to the current thread. The chat UI gains a chip rail above the composer that subscribes to Supabase realtime for live status.

**Tech Stack:** Next.js (App Router) + React 19 · Supabase (Postgres + Storage + Realtime) · pgvector + tsvector · Kysely · Inngest · Vercel `ai` SDK + `@ai-sdk/anthropic` (PDF extraction via Claude Haiku) · `mammoth` (DOCX) · `openai` (embeddings) · `js-tiktoken` (chunk sizing) · Vitest.

**Spec:** [docs/superpowers/specs/2026-05-08-attach-text-documents-design.md](../specs/2026-05-08-attach-text-documents-design.md)

---

## File structure

```
supabase/migrations/
  20260508_documents_schema.sql            (NEW)

src/lib/
  env.ts                                    (MODIFY: add OPENAI_API_KEY)
  documents/
    chunk.ts                                (NEW: token windowing + boundary snap)
    chunk.test.ts                           (NEW)
    extract.ts                              (NEW: pdf/docx/md/txt extraction)
    extract.test.ts                         (NEW)
    embed.ts                                (NEW: openai batched embedding)
    embed.test.ts                           (NEW)
    types.ts                                (NEW: shared types)
  storage/
    documents.ts                            (NEW: bucket up/download/delete)
  ai/tools/
    documents.ts                            (NEW: search_corpus + neighbors + metadata)
    documents.test.ts                       (NEW)
  inngest/
    client.ts                               (UNCHANGED)
    channels.ts                             (UNCHANGED)
    functions.ts                            (MODIFY: register documentIngest, wire tools to chatStream)
    document-ingest.ts                      (NEW: documentIngest function)

src/app/
  api/threads/[id]/documents/
    route.ts                                (NEW: POST + GET)
    route.test.ts                           (NEW)
  (authed)/chat/
    chat-view.tsx                           (MODIFY: composer paperclip, parts rendering)
    document-chip-rail.tsx                  (NEW: realtime chip component)
    use-thread-documents.ts                 (NEW: hook for SSR + realtime list)
    page.tsx                                (MODIFY: SSR initial documents list)
```

**Why this split:**

- `src/lib/documents/{chunk,extract,embed}.ts` are pure(-ish) modules with one responsibility each. They're easy to TDD without spinning up Inngest or the DB.
- `src/lib/ai/tools/documents.ts` is co-located with future AI-SDK tooling (not under `inngest/`) because the tool factory is consumed by `streamText` and could be reused by other agents later.
- `document-ingest.ts` is split out of `functions.ts` because it's substantial and depends on five different modules; keeping it in its own file avoids a 600-line `functions.ts`.

---

## Task 0: Documents schema migration

**Goal:** Create `documents`, `chunks`, `messages.parts`, the storage bucket, and add `documents` to the realtime publication.

**Files:**
- Create: `supabase/migrations/20260508_documents_schema.sql`

**Acceptance Criteria:**
- [ ] `pnpm db:reset` runs cleanly with no errors.
- [ ] `\d public.documents` shows expected columns/indexes/policies.
- [ ] `\d public.chunks` shows expected columns and the HNSW + GIN indexes.
- [ ] `select * from pg_publication_tables where pubname='supabase_realtime' and tablename='documents';` returns one row.
- [ ] `pnpm generate` produces typed entries for `documents`, `chunks`, and `messages.parts`.

**Verify:** `pnpm db:reset && pnpm generate && pnpm typecheck`

**Steps:**

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260508_documents_schema.sql

-- pgvector ------------------------------------------------------------------
create extension if not exists vector with schema extensions;

-- documents -----------------------------------------------------------------
create table public.documents (
  id              uuid primary key default public.uuid_generate_v7(),
  thread_id       uuid not null references public.threads(id) on delete cascade,
  user_id         uuid not null references auth.users(id)    on delete cascade,
  name            text not null,
  mime            text not null,
  byte_size       bigint not null,
  kind            text not null check (kind in ('pdf','docx','md','txt')),
  storage_path    text not null,
  status          text not null default 'processing'
                  check (status in ('processing','ready','failed')),
  error_code      text,
  error_message   text,
  token_count     int,
  chunk_count     int,
  created_at      timestamptz not null default now(),
  ready_at        timestamptz,
  unique (thread_id, name)
);
create index documents_thread_id_status_idx on public.documents (thread_id, status);

-- chunks --------------------------------------------------------------------
create table public.chunks (
  id              uuid primary key default public.uuid_generate_v7(),
  document_id     uuid not null references public.documents(id) on delete cascade,
  thread_id       uuid not null references public.threads(id)   on delete cascade,
  chunk_index     int  not null,
  content         text not null,
  token_count     int  not null,
  embedding       extensions.vector(1536) not null,
  embedding_model text not null,
  fts             tsvector generated always as (to_tsvector('english', content)) stored,
  created_at      timestamptz not null default now(),
  unique (document_id, chunk_index)
);
create index chunks_thread_id_idx       on public.chunks (thread_id);
create index chunks_embedding_model_idx on public.chunks (embedding_model);
create index chunks_fts_gin             on public.chunks using gin (fts);
create index chunks_embedding_hnsw      on public.chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- messages.parts ------------------------------------------------------------
alter table public.messages add column parts jsonb;

-- RLS -----------------------------------------------------------------------
alter table public.documents enable row level security;
alter table public.chunks    enable row level security;

create policy "documents_select_own" on public.documents
  for select using (user_id = (select auth.uid()));
create policy "documents_insert_own" on public.documents
  for insert with check (user_id = (select auth.uid()));
create policy "documents_update_own" on public.documents
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "documents_delete_own" on public.documents
  for delete using (user_id = (select auth.uid()));

create policy "chunks_select_own" on public.chunks
  for select using (
    exists (select 1 from public.documents d
            where d.id = chunks.document_id and d.user_id = (select auth.uid()))
  );

-- Realtime publication: chip rail subscribes to INSERT/UPDATE on documents.
alter publication supabase_realtime add table public.documents;

-- Storage bucket ------------------------------------------------------------
insert into storage.buckets (id, name, public)
  values ('documents', 'documents', false)
  on conflict (id) do nothing;

create policy "documents_storage_select_own" on storage.objects
  for select using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
-- Inserts/updates/deletes go through service role — no client-side write policy.
```

- [ ] **Step 2: Apply and verify**

Run: `pnpm db:reset`
Expected: clean output, no errors.

Run: `psql "$SUPABASE_DB_URL" -c "\d public.documents"`
Expected: shows the 14 columns, `documents_thread_id_status_idx`, the four RLS policies.

Run: `psql "$SUPABASE_DB_URL" -c "\d public.chunks"`
Expected: shows `chunks_fts_gin`, `chunks_embedding_hnsw`, `chunks_embedding_model_idx`.

Run: `psql "$SUPABASE_DB_URL" -c "select * from pg_publication_tables where pubname='supabase_realtime' and tablename='documents';"`
Expected: one row.

- [ ] **Step 3: Regenerate types**

Run: `pnpm generate && pnpm typecheck`
Expected: `database.types.ts` contains `documents`, `chunks`, and `messages.parts`. Typecheck passes.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260508_documents_schema.sql src/lib/db/database.types.ts
git commit -m "feat(docs): schema for documents, chunks, and message parts (#4)"
```

---

## Task 1: Add new env var + dependencies

**Goal:** Install `mammoth`, `js-tiktoken`, `openai`. Add `OPENAI_API_KEY` to env validation and example.

**Files:**
- Modify: `package.json`
- Modify: `src/lib/env.ts`
- Modify: `.env.example`

**Acceptance Criteria:**
- [ ] `pnpm install` succeeds.
- [ ] `env.ts` exposes `OPENAI_API_KEY` (already present per the read above; verify and keep).
- [ ] `.env.example` documents the new variable.

**Verify:** `pnpm install && pnpm typecheck`

**Steps:**

- [ ] **Step 1: Install deps**

Run: `pnpm add mammoth js-tiktoken openai`
Expected: lockfile updates; no errors.

- [ ] **Step 2: Verify `OPENAI_API_KEY` already in `src/lib/env.ts`**

The current schema already includes `OPENAI_API_KEY: z.string().min(1).optional()`. No change required. If the line is missing in a future state, add it under the existing `serverSchema`.

- [ ] **Step 3: Update `.env.example`**

Append (preserving existing content):

```
# OpenAI — embeddings for document indexing (text-embedding-3-small)
OPENAI_API_KEY=
```

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml .env.example
git commit -m "feat(docs): add mammoth, js-tiktoken, openai deps and OPENAI_API_KEY env (#4)"
```

---

## Task 2: Storage helper

**Goal:** A small server-only module wrapping the `documents` bucket so callers don't repeat path construction or service-role wiring.

**Files:**
- Create: `src/lib/storage/documents.ts`
- Create: `src/lib/storage/documents.test.ts`

**Acceptance Criteria:**
- [ ] `documentObjectPath({ userId, threadId, documentId, ext })` returns `"<userId>/<threadId>/<documentId>.<ext>"`.
- [ ] `uploadDocumentBlob` puts bytes; `downloadDocumentBlob` reads them back as `Uint8Array`; `deleteDocumentBlob` removes them.
- [ ] All three throw on Supabase error (no silent failure).

**Verify:** `pnpm test src/lib/storage/documents.test.ts`

**Steps:**

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/storage/documents.test.ts
import { describe, expect, it, vi } from 'vitest';
import { documentObjectPath } from './documents';

describe('documentObjectPath', () => {
  it('builds <user>/<thread>/<doc>.<ext>', () => {
    expect(
      documentObjectPath({
        userId: 'u-1',
        threadId: 't-1',
        documentId: 'd-1',
        ext: 'pdf',
      }),
    ).toBe('u-1/t-1/d-1.pdf');
  });

  it('lowercases the extension', () => {
    expect(
      documentObjectPath({
        userId: 'u-1',
        threadId: 't-1',
        documentId: 'd-1',
        ext: 'PDF',
      }),
    ).toBe('u-1/t-1/d-1.pdf');
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `pnpm test src/lib/storage/documents.test.ts`
Expected: Cannot find module `./documents`.

- [ ] **Step 3: Implement**

```ts
// src/lib/storage/documents.ts
import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

export const DOCUMENTS_BUCKET = 'documents';

export interface DocumentObjectPathArgs {
  userId: string;
  threadId: string;
  documentId: string;
  ext: string;
}

export function documentObjectPath({
  userId,
  threadId,
  documentId,
  ext,
}: DocumentObjectPathArgs): string {
  return `${userId}/${threadId}/${documentId}.${ext.toLowerCase()}`;
}

export async function uploadDocumentBlob(args: {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}) {
  const supabase = createAdminClient();
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(args.path, args.bytes, {
      contentType: args.contentType,
      upsert: false,
    });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
}

export async function downloadDocumentBlob(path: string): Promise<Uint8Array> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).download(path);
  if (error || !data) throw new Error(`storage download failed: ${error?.message ?? 'no data'}`);
  return new Uint8Array(await data.arrayBuffer());
}

export async function deleteDocumentBlob(path: string) {
  const supabase = createAdminClient();
  const { error } = await supabase.storage.from(DOCUMENTS_BUCKET).remove([path]);
  if (error) throw new Error(`storage delete failed: ${error.message}`);
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `pnpm test src/lib/storage/documents.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage/
git commit -m "feat(docs): documents storage helper (#4)"
```

---

## Task 3: Tokenizer + chunker

**Goal:** Pure module that produces ordered chunks from extracted text. 800-token windows with 100-token overlap, single chunk if total < 2000 tokens, boundary-snapped.

**Files:**
- Create: `src/lib/documents/types.ts`
- Create: `src/lib/documents/chunk.ts`
- Create: `src/lib/documents/chunk.test.ts`

**Acceptance Criteria:**
- [ ] `chunkText('short content')` returns one chunk with `chunk_index = 0`.
- [ ] `chunkText` of a 4000-token text returns >= 5 chunks with `chunk_index` 0..N.
- [ ] Each non-final chunk has `token_count` ≈ 800 (within ±50).
- [ ] Successive chunks overlap by ~100 tokens (re-tokenizing chunk N-1 tail and chunk N head share tokens).
- [ ] Boundary snap: when a `\n\n` sits within ±50 tokens of a target end, the chunk ends at that paragraph break.

**Verify:** `pnpm test src/lib/documents/chunk.test.ts`

**Steps:**

- [ ] **Step 1: Define shared types**

```ts
// src/lib/documents/types.ts
export type DocumentKind = 'pdf' | 'docx' | 'md' | 'txt';

export interface Chunk {
  chunk_index: number;
  content: string;
  token_count: number;
}
```

- [ ] **Step 2: Write failing tests**

```ts
// src/lib/documents/chunk.test.ts
import { describe, expect, it } from 'vitest';
import { chunkText, countTokens } from './chunk';

const PARAGRAPH = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';

describe('chunkText', () => {
  it('returns a single chunk for short input', () => {
    const chunks = chunkText('hello world');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunk_index).toBe(0);
    expect(chunks[0]?.content).toBe('hello world');
    expect(chunks[0]?.token_count).toBe(countTokens('hello world'));
  });

  it('returns one chunk when total tokens < 2000', () => {
    const text = PARAGRAPH.repeat(100); // ~800 tokens
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(text);
  });

  it('splits long text into multiple chunks indexed from 0', () => {
    const text = PARAGRAPH.repeat(500); // ~4000 tokens
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.map((c) => c.chunk_index)).toEqual(
      Array.from({ length: chunks.length }, (_, i) => i),
    );
  });

  it('non-final chunks are ~800 tokens (within ±60)', () => {
    const text = PARAGRAPH.repeat(500);
    const chunks = chunkText(text);
    for (const c of chunks.slice(0, -1)) {
      expect(c.token_count).toBeGreaterThanOrEqual(740);
      expect(c.token_count).toBeLessThanOrEqual(860);
    }
  });

  it('successive chunks overlap', () => {
    const text = PARAGRAPH.repeat(500);
    const chunks = chunkText(text);
    const a = chunks[0];
    const b = chunks[1];
    if (!a || !b) throw new Error('expected at least 2 chunks');
    const tail = a.content.slice(-200);
    expect(b.content.startsWith(tail) || b.content.includes(tail.slice(-50))).toBe(true);
  });

  it('snaps to a paragraph boundary when one is within ±50 tokens of target', () => {
    // Build text where a \n\n falls right around the 800-token target.
    const head = PARAGRAPH.repeat(99); // ~792 tokens
    const text = `${head}\n\n${PARAGRAPH.repeat(500)}`;
    const chunks = chunkText(text);
    expect(chunks[0]?.content.endsWith(head)).toBe(true);
  });
});

describe('countTokens', () => {
  it('returns a positive integer for non-empty strings', () => {
    expect(countTokens('hello world')).toBeGreaterThan(0);
  });
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });
});
```

- [ ] **Step 3: Run test, expect failure**

Run: `pnpm test src/lib/documents/chunk.test.ts`
Expected: cannot find module.

- [ ] **Step 4: Implement**

```ts
// src/lib/documents/chunk.ts
import { encodingForModel } from 'js-tiktoken';
import type { Chunk } from './types';

const TARGET_TOKENS = 800;
const OVERLAP_TOKENS = 100;
const SINGLE_CHUNK_THRESHOLD = 2000;
const SNAP_WINDOW = 50;

// `text-embedding-3-small` uses cl100k_base. js-tiktoken's `encodingForModel`
// resolves to cl100k_base for that model id. Cached at module level — the
// encoder build is non-trivial.
const enc = encodingForModel('text-embedding-3-small');

export function countTokens(text: string): number {
  if (!text) return 0;
  return enc.encode(text).length;
}

export function chunkText(text: string): Chunk[] {
  const total = countTokens(text);
  if (total === 0) return [];
  if (total < SINGLE_CHUNK_THRESHOLD) {
    return [{ chunk_index: 0, content: text, token_count: total }];
  }

  const tokens = enc.encode(text);
  const chunks: Chunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < tokens.length) {
    const targetEnd = Math.min(start + TARGET_TOKENS, tokens.length);
    const end = snapBoundary(text, tokens, targetEnd);

    const slice = tokens.slice(start, end);
    const content = enc.decode(slice);
    chunks.push({
      chunk_index: chunkIndex,
      content,
      token_count: slice.length,
    });

    if (end >= tokens.length) break;
    start = Math.max(end - OVERLAP_TOKENS, start + 1);
    chunkIndex += 1;
  }

  return chunks;
}

/**
 * Try to end the chunk at a paragraph break (`\n\n`) within ±SNAP_WINDOW tokens
 * of `targetEnd`. Falls back to a sentence break (`. `, `! `, `? `), then to a
 * hard cut at `targetEnd`.
 */
function snapBoundary(text: string, tokens: number[], targetEnd: number): number {
  const lo = Math.max(targetEnd - SNAP_WINDOW, 1);
  const hi = Math.min(targetEnd + SNAP_WINDOW, tokens.length);
  // Decode the search window once, scan for separators in the decoded text,
  // map back to a token index by re-encoding the prefix.
  const windowTokens = tokens.slice(0, hi);
  const windowText = enc.decode(windowTokens);
  const targetText = enc.decode(tokens.slice(0, targetEnd));
  const targetPos = targetText.length;

  const para = findNearest(windowText, ['\n\n'], targetPos, SNAP_WINDOW * 4);
  if (para !== -1 && para > lo * 2) {
    return enc.encode(windowText.slice(0, para + 2)).length;
  }
  const sent = findNearest(windowText, ['. ', '! ', '? '], targetPos, SNAP_WINDOW * 4);
  if (sent !== -1 && sent > lo * 2) {
    return enc.encode(windowText.slice(0, sent + 2)).length;
  }
  return targetEnd;
}

function findNearest(haystack: string, needles: string[], pos: number, charWindow: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (const n of needles) {
    let i = haystack.lastIndexOf(n, pos);
    while (i !== -1) {
      const d = Math.abs(i - pos);
      if (d <= charWindow && d < bestDist) {
        best = i;
        bestDist = d;
      }
      if (i === 0) break;
      i = haystack.lastIndexOf(n, i - 1);
    }
    let j = haystack.indexOf(n, pos);
    while (j !== -1) {
      const d = Math.abs(j - pos);
      if (d <= charWindow && d < bestDist) {
        best = j;
        bestDist = d;
      }
      j = haystack.indexOf(n, j + 1);
    }
  }
  return best;
}
```

- [ ] **Step 5: Run test, expect pass**

Run: `pnpm test src/lib/documents/chunk.test.ts`
Expected: 7 passed.

If any case fails, refine `snapBoundary` constants — the boundary heuristic is the only nuanced part. Do not adjust the test assertions.

- [ ] **Step 6: Commit**

```bash
git add src/lib/documents/
git commit -m "feat(docs): tokenizer + chunker (#4)"
```

---

## Task 4: Extractor

**Goal:** Module that extracts plain text from a buffer given its kind. PDF via Anthropic Haiku, DOCX via mammoth, MD/TXT raw decode.

**Files:**
- Create: `src/lib/documents/extract.ts`
- Create: `src/lib/documents/extract.test.ts`

**Acceptance Criteria:**
- [ ] `extractText({ kind: 'txt', bytes, byteSize })` returns the UTF-8 decoded string.
- [ ] `extractText({ kind: 'md', bytes, byteSize })` preserves markup.
- [ ] `extractText({ kind: 'docx', bytes, byteSize })` calls `mammoth.extractRawText` (mocked).
- [ ] `extractText({ kind: 'pdf', bytes, byteSize })` calls Anthropic Haiku via `@ai-sdk/anthropic` (mocked); throws `ExtractTooLargeError` when `finishReason === 'length'`; throws `ExtractEmptyError` when output is < 50 chars and byteSize > 100KB.

**Verify:** `pnpm test src/lib/documents/extract.test.ts`

**Steps:**

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/documents/extract.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateTextMock = vi.fn();
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, generateText: generateTextMock };
});

const extractRawTextMock = vi.fn();
vi.mock('mammoth', () => ({
  default: { extractRawText: extractRawTextMock },
  extractRawText: extractRawTextMock,
}));

import { ExtractEmptyError, ExtractTooLargeError, extractText } from './extract';

const enc = new TextEncoder();

beforeEach(() => {
  generateTextMock.mockReset();
  extractRawTextMock.mockReset();
});

describe('extractText (txt)', () => {
  it('decodes utf-8', async () => {
    const bytes = enc.encode('hello world');
    await expect(
      extractText({ kind: 'txt', bytes, byteSize: bytes.length }),
    ).resolves.toBe('hello world');
  });
});

describe('extractText (md)', () => {
  it('preserves markdown', async () => {
    const bytes = enc.encode('# Title\n\n**bold**');
    await expect(
      extractText({ kind: 'md', bytes, byteSize: bytes.length }),
    ).resolves.toBe('# Title\n\n**bold**');
  });
});

describe('extractText (docx)', () => {
  it('calls mammoth.extractRawText', async () => {
    extractRawTextMock.mockResolvedValueOnce({ value: 'docx text' });
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(
      extractText({ kind: 'docx', bytes, byteSize: 3 }),
    ).resolves.toBe('docx text');
    expect(extractRawTextMock).toHaveBeenCalledOnce();
  });
});

describe('extractText (pdf)', () => {
  it('calls Anthropic Haiku and returns text', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'extracted pdf text',
      finishReason: 'stop',
    });
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    await expect(
      extractText({ kind: 'pdf', bytes, byteSize: bytes.length }),
    ).resolves.toBe('extracted pdf text');
    expect(generateTextMock).toHaveBeenCalledOnce();
  });

  it('throws ExtractTooLargeError on finishReason=length', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'partial',
      finishReason: 'length',
    });
    await expect(
      extractText({ kind: 'pdf', bytes: new Uint8Array(200_000), byteSize: 200_000 }),
    ).rejects.toBeInstanceOf(ExtractTooLargeError);
  });

  it('throws ExtractEmptyError when result is tiny and source is big (scanned PDF)', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'hi', finishReason: 'stop' });
    await expect(
      extractText({ kind: 'pdf', bytes: new Uint8Array(200_000), byteSize: 200_000 }),
    ).rejects.toBeInstanceOf(ExtractEmptyError);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `pnpm test src/lib/documents/extract.test.ts`
Expected: cannot find module `./extract`.

- [ ] **Step 3: Implement**

```ts
// src/lib/documents/extract.ts
import 'server-only';

import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import mammoth from 'mammoth';
import type { DocumentKind } from './types';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const HAIKU_MAX_OUTPUT_TOKENS = 32_000;
const PDF_EXTRACT_PROMPT =
  'Extract all text from this PDF in reading order. Preserve paragraph breaks. Do not summarize, comment, or add anything.';
const SCANNED_PDF_OUTPUT_THRESHOLD = 50;
const SCANNED_PDF_INPUT_BYTES = 100 * 1024;

export class ExtractTooLargeError extends Error {
  readonly code = 'extract_too_large';
}
export class ExtractEmptyError extends Error {
  readonly code = 'extract_empty';
}

export interface ExtractArgs {
  kind: DocumentKind;
  bytes: Uint8Array;
  byteSize: number;
}

export async function extractText({ kind, bytes, byteSize }: ExtractArgs): Promise<string> {
  switch (kind) {
    case 'txt':
    case 'md':
      return new TextDecoder('utf-8').decode(bytes);
    case 'docx': {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      return result.value;
    }
    case 'pdf': {
      const result = await generateText({
        model: anthropic(HAIKU_MODEL),
        maxOutputTokens: HAIKU_MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PDF_EXTRACT_PROMPT },
              { type: 'file', mediaType: 'application/pdf', data: bytes },
            ],
          },
        ],
      });
      if (result.finishReason === 'length') {
        throw new ExtractTooLargeError('PDF exceeded extractor max output');
      }
      const text = result.text.trim();
      if (text.length < SCANNED_PDF_OUTPUT_THRESHOLD && byteSize > SCANNED_PDF_INPUT_BYTES) {
        throw new ExtractEmptyError(
          'PDF produced almost no text (likely scanned/image-only)',
        );
      }
      return text;
    }
  }
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `pnpm test src/lib/documents/extract.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/documents/extract.ts src/lib/documents/extract.test.ts
git commit -m "feat(docs): extract text from pdf/docx/md/txt (#4)"
```

---

## Task 5: Embedder

**Goal:** Module that embeds an array of chunks via OpenAI in batches of 96, returning parallel-array vectors + the model id.

**Files:**
- Create: `src/lib/documents/embed.ts`
- Create: `src/lib/documents/embed.test.ts`

**Acceptance Criteria:**
- [ ] `embedChunks(['a', 'b'])` returns `{ model: 'text-embedding-3-small', vectors: number[][] }` with length 2 and dim 1536 (mocked).
- [ ] Batches of >96 chunks split into multiple OpenAI calls.
- [ ] Errors from OpenAI propagate (no swallowing).

**Verify:** `pnpm test src/lib/documents/embed.test.ts`

**Steps:**

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/documents/embed.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    embeddings: { create: createMock },
  })),
}));

import { EMBEDDING_MODEL, embedChunks } from './embed';

beforeEach(() => createMock.mockReset());

const fakeVector = (seed: number) =>
  Array.from({ length: 1536 }, (_, i) => (seed + i) / 10000);

describe('embedChunks', () => {
  it('returns model id and parallel vectors', async () => {
    createMock.mockResolvedValueOnce({
      data: [{ embedding: fakeVector(1) }, { embedding: fakeVector(2) }],
    });
    const out = await embedChunks(['a', 'b']);
    expect(out.model).toBe(EMBEDDING_MODEL);
    expect(out.vectors).toHaveLength(2);
    expect(out.vectors[0]).toHaveLength(1536);
  });

  it('batches when input length > 96', async () => {
    const first = Array.from({ length: 96 }, (_, i) => ({ embedding: fakeVector(i) }));
    const second = Array.from({ length: 4 }, (_, i) => ({ embedding: fakeVector(96 + i) }));
    createMock
      .mockResolvedValueOnce({ data: first })
      .mockResolvedValueOnce({ data: second });

    const inputs = Array.from({ length: 100 }, (_, i) => `chunk ${i}`);
    const out = await embedChunks(inputs);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(out.vectors).toHaveLength(100);
  });

  it('propagates errors', async () => {
    createMock.mockRejectedValueOnce(new Error('rate limited'));
    await expect(embedChunks(['x'])).rejects.toThrow('rate limited');
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `pnpm test src/lib/documents/embed.test.ts`
Expected: cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/lib/documents/embed.ts
import 'server-only';

import OpenAI from 'openai';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;
const BATCH_SIZE = 96;

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export interface EmbedResult {
  model: typeof EMBEDDING_MODEL;
  vectors: number[][];
}

export async function embedChunks(inputs: string[]): Promise<EmbedResult> {
  const vectors: number[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch = inputs.slice(i, i + BATCH_SIZE);
    const res = await client().embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    for (const item of res.data) {
      vectors.push(item.embedding);
    }
  }
  return { model: EMBEDDING_MODEL, vectors };
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `pnpm test src/lib/documents/embed.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/documents/embed.ts src/lib/documents/embed.test.ts
git commit -m "feat(docs): batched openai embeddings (#4)"
```

---

## Task 6: documentIngest Inngest function

**Goal:** Wire `extract → chunk → embed → index` as Inngest steps; on success flip `documents.status='ready'`; on failure flip to `failed` with structured error code.

**Files:**
- Create: `src/lib/inngest/document-ingest.ts`
- Modify: `src/lib/inngest/functions.ts` (re-export)

**Acceptance Criteria:**
- [ ] Function id is `document-ingest`, triggered by `document/ingest.requested`.
- [ ] On success: `documents` row has `status='ready'`, `token_count`, `chunk_count`, `ready_at` set; `chunks` rows exist.
- [ ] On extract failure: `status='failed'`, `error_code` matches the thrown error's `code` field.
- [ ] On embed failure: same shape, `error_code='embed_failed'`.
- [ ] If conversation token cap would be exceeded, fail with `error_code='conversation_token_cap'`.
- [ ] Concurrency limit set to 5.

**Verify:** No DB-level test in this task; verified end-to-end in Task 13. Typecheck: `pnpm typecheck`.

**Steps:**

- [ ] **Step 1: Implement**

```ts
// src/lib/inngest/document-ingest.ts
import { adminDb } from '@/lib/db/admin';
import {
  ExtractEmptyError,
  ExtractTooLargeError,
  extractText,
} from '@/lib/documents/extract';
import { chunkText, countTokens } from '@/lib/documents/chunk';
import { embedChunks, EMBEDDING_MODEL } from '@/lib/documents/embed';
import { downloadDocumentBlob } from '@/lib/storage/documents';
import { inngest } from './client';

const CONVERSATION_TOKEN_CAP = 500_000;

interface IngestPayload {
  documentId: string;
}

export const documentIngest = inngest.createFunction(
  {
    id: 'document-ingest',
    name: 'Documents: extract → chunk → embed → index',
    triggers: [{ event: 'document/ingest.requested' }],
    concurrency: { limit: 5 },
  },
  async ({ event, step, logger }) => {
    const { documentId } = event.data as IngestPayload;

    const doc = await step.run('load-doc', async () =>
      adminDb
        .selectFrom('documents')
        .select(['id', 'thread_id', 'kind', 'storage_path', 'byte_size'])
        .where('id', '=', documentId)
        .executeTakeFirst(),
    );
    if (!doc) {
      logger.warn('document row missing', { documentId });
      return { ok: false, reason: 'missing' as const };
    }

    try {
      const text = await step.run('extract', async () => {
        const bytes = await downloadDocumentBlob(doc.storage_path);
        return extractText({
          kind: doc.kind as 'pdf' | 'docx' | 'md' | 'txt',
          bytes,
          byteSize: Number(doc.byte_size),
        });
      });

      const { chunks, totalTokens } = await step.run('chunk', async () => {
        const chunks = chunkText(text);
        const totalTokens = chunks.reduce((s, c) => s + c.token_count, 0);

        const existing = await adminDb
          .selectFrom('documents')
          .select(({ fn }) => [fn.sum<number>('token_count').as('sum')])
          .where('thread_id', '=', doc.thread_id)
          .where('status', '=', 'ready')
          .executeTakeFirst();
        const existingTotal = Number(existing?.sum ?? 0);
        if (existingTotal + totalTokens > CONVERSATION_TOKEN_CAP) {
          throw new ConversationTokenCapError(
            `would exceed per-conversation cap (${existingTotal} + ${totalTokens} > ${CONVERSATION_TOKEN_CAP})`,
          );
        }
        return { chunks, totalTokens };
      });

      const vectors = await step.run('embed', async () => {
        const { vectors } = await embedChunks(chunks.map((c) => c.content));
        return vectors;
      });

      await step.run('index', async () => {
        await adminDb.transaction().execute(async (trx) => {
          await trx
            .insertInto('chunks')
            .values(
              chunks.map((c, i) => ({
                document_id: documentId,
                thread_id: doc.thread_id,
                chunk_index: c.chunk_index,
                content: c.content,
                token_count: c.token_count,
                // pgvector accepts the array-literal text format.
                embedding: `[${vectors[i]?.join(',')}]` as unknown as never,
                embedding_model: EMBEDDING_MODEL,
              })),
            )
            .execute();

          await trx
            .updateTable('documents')
            .set({
              status: 'ready',
              token_count: totalTokens,
              chunk_count: chunks.length,
              ready_at: new Date().toISOString(),
            })
            .where('id', '=', documentId)
            .execute();
        });
      });

      return { ok: true as const, chunks: chunks.length, tokens: totalTokens };
    } catch (err) {
      const { code, message } = classifyError(err);
      logger.error('document-ingest failed', { documentId, code, message });
      await adminDb
        .updateTable('documents')
        .set({ status: 'failed', error_code: code, error_message: message })
        .where('id', '=', documentId)
        .execute();
      return { ok: false as const, code };
    }
  },
);

class ConversationTokenCapError extends Error {
  readonly code = 'conversation_token_cap';
}

function classifyError(err: unknown): { code: string; message: string } {
  if (err instanceof ExtractTooLargeError)   return { code: err.code, message: err.message };
  if (err instanceof ExtractEmptyError)      return { code: err.code, message: err.message };
  if (err instanceof ConversationTokenCapError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { code: 'embed_failed', message: err.message };
  return { code: 'embed_failed', message: 'unknown error' };
}
```

> Note: the `embed_failed` default in `classifyError` is the catch-all for any non-typed error. Typed errors from `extract.ts` carry their own code; everything else (network, OpenAI rate limits, DB errors during `index`) falls through as `embed_failed`. Refining this further is out of scope for v1.

- [ ] **Step 2: Register the function**

Modify `src/lib/inngest/functions.ts` to import and re-export `documentIngest`. The current file ends with:

```ts
export const functions = [chatStream, chatStreamTimeoutCleanup];
```

Replace with:

```ts
export { documentIngest } from './document-ingest';

import { documentIngest } from './document-ingest';

export const functions = [chatStream, chatStreamTimeoutCleanup, documentIngest];
```

- [ ] **Step 3: Verify it registers**

Run: `pnpm typecheck`
Expected: passes.

Run: `pnpm dev` (in another terminal), then `curl -s http://localhost:8288/v1/apps | jq '.[].functions[].id'`
Expected: includes `"dawn-document-ingest"` (Inngest namespaces with the app id).

Stop dev when done.

- [ ] **Step 4: Commit**

```bash
git add src/lib/inngest/
git commit -m "feat(docs): documentIngest Inngest function (#4)"
```

---

## Task 7: Upload + read routes

**Goal:** `POST /api/threads/:id/documents` (multipart) and `GET /api/threads/:id/documents` (list). Validation per spec; route triggers Inngest.

**Files:**
- Create: `src/app/api/threads/[id]/documents/route.ts`
- Create: `src/app/api/threads/[id]/documents/route.test.ts`

**Acceptance Criteria:**
- [ ] `POST` returns 401 unauthenticated, 404 if thread isn't owned, 413 on oversize, 415 on bad mime, 409 on duplicate name / file count cap / conversation token cap, 201 on success.
- [ ] `POST` uploads to Storage, inserts `documents` row (`status='processing'`), and sends `document/ingest.requested`.
- [ ] `GET` returns the user's documents for the thread (404 if not owned).

**Verify:** `pnpm test src/app/api/threads/\[id\]/documents/route.test.ts`

**Steps:**

- [ ] **Step 1: Write the route**

```ts
// src/app/api/threads/[id]/documents/route.ts
import 'server-only';

import { adminDb } from '@/lib/db/admin';
import { inngest } from '@/lib/inngest/client';
import { documentObjectPath, uploadDocumentBlob, deleteDocumentBlob } from '@/lib/storage/documents';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_DOCS_PER_THREAD = 10;
const TOKEN_CAP = 500_000;

const KIND_BY_MIME = new Map<string, { kind: 'pdf' | 'docx' | 'md' | 'txt'; ext: string }>([
  ['application/pdf',                                                              { kind: 'pdf',  ext: 'pdf' }],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document',      { kind: 'docx', ext: 'docx' }],
  ['text/markdown',                                                                { kind: 'md',   ext: 'md' }],
  ['text/plain',                                                                   { kind: 'txt',  ext: 'txt' }],
]);

function err(status: number, code: string, extras: Record<string, unknown> = {}) {
  return Response.json({ error: code, ...extras }, { status });
}

async function ensureOwned(threadId: string, userId: string) {
  const t = await adminDb
    .selectFrom('threads')
    .select(['id'])
    .where('id', '=', threadId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return !!t;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: threadId } = await ctx.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return err(401, 'unauthorized');
  if (!(await ensureOwned(threadId, user.id))) return err(404, 'not_found');

  const rows = await adminDb
    .selectFrom('documents')
    .select(['id', 'name', 'kind', 'byte_size', 'status', 'error_code', 'error_message', 'created_at', 'ready_at'])
    .where('thread_id', '=', threadId)
    .orderBy('created_at', 'asc')
    .execute();
  return Response.json({ documents: rows });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: threadId } = await ctx.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return err(401, 'unauthorized');
  if (!(await ensureOwned(threadId, user.id))) return err(404, 'not_found');

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err(400, 'invalid_body');
  }
  const file = form.get('file');
  if (!(file instanceof File)) return err(400, 'invalid_body');

  if (file.size > MAX_BYTES) return err(413, 'too_large');
  const k = KIND_BY_MIME.get(file.type);
  if (!k) return err(415, 'unsupported_type');

  const counts = await adminDb
    .selectFrom('documents')
    .select(({ fn }) => [
      fn.count<number>('id').as('count'),
      fn.sum<number>('token_count').as('tokens'),
    ])
    .where('thread_id', '=', threadId)
    .where('status', '!=', 'failed')
    .executeTakeFirst();
  if ((counts?.count ?? 0) >= MAX_DOCS_PER_THREAD) return err(409, 'file_count_cap');

  // Estimate: tokens ≈ bytes / 3 (generous).
  const estTokens = Math.floor(file.size / 3);
  if ((Number(counts?.tokens ?? 0)) + estTokens > TOKEN_CAP) {
    return err(409, 'conversation_token_cap');
  }

  const dup = await adminDb
    .selectFrom('documents')
    .select(['id'])
    .where('thread_id', '=', threadId)
    .where('name', '=', file.name)
    .executeTakeFirst();
  if (dup) return err(409, 'duplicate_name');

  const documentId = crypto.randomUUID(); // server-side; DB also defaults
  const path = documentObjectPath({
    userId: user.id,
    threadId,
    documentId,
    ext: k.ext,
  });
  const bytes = new Uint8Array(await file.arrayBuffer());

  await uploadDocumentBlob({ path, bytes, contentType: file.type });

  let inserted: { id: string } | undefined;
  try {
    inserted = await adminDb
      .insertInto('documents')
      .values({
        id: documentId,
        thread_id: threadId,
        user_id: user.id,
        name: file.name,
        mime: file.type,
        byte_size: file.size,
        kind: k.kind,
        storage_path: path,
        status: 'processing',
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    await inngest.send({
      name: 'document/ingest.requested',
      data: { documentId: inserted.id },
    });
  } catch (e) {
    await deleteDocumentBlob(path).catch(() => {});
    throw e;
  }

  return Response.json(
    {
      document: {
        id: inserted.id,
        name: file.name,
        kind: k.kind,
        byte_size: file.size,
        status: 'processing',
      },
    },
    { status: 201 },
  );
}
```

- [ ] **Step 2: Write tests**

```ts
// src/app/api/threads/[id]/documents/route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getUser = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

const inngestSend = vi.fn().mockResolvedValue({ ids: ['evt'] });
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: inngestSend } }));

const upload = vi.fn().mockResolvedValue(undefined);
const del = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/storage/documents', async () => {
  const actual = await vi.importActual<typeof import('@/lib/storage/documents')>(
    '@/lib/storage/documents',
  );
  return {
    ...actual,
    uploadDocumentBlob: upload,
    deleteDocumentBlob: del,
  };
});

const dbMock = {
  selectFrom: vi.fn(),
  insertInto: vi.fn(),
};
vi.mock('@/lib/db/admin', () => ({ adminDb: dbMock }));

import { POST } from './route';

function makeReq(file: File): Request {
  const fd = new FormData();
  fd.set('file', file);
  return new Request('http://test/api/threads/t/documents', {
    method: 'POST',
    body: fd,
  });
}
function ctx() { return { params: Promise.resolve({ id: 't' }) }; }

beforeEach(() => {
  getUser.mockResolvedValue({ data: { user: { id: 'u' } } });
  // Default chained-builder behavior — overridden per test.
  dbMock.selectFrom.mockReturnValue(chainOwned());
});
afterEach(() => vi.clearAllMocks());

function chainOwned() {
  // ensureOwned chain
  return {
    select: () => ({
      where: () => ({
        where: () => ({ executeTakeFirst: async () => ({ id: 't' }) }),
      }),
    }),
  };
}

describe('POST /api/threads/[id]/documents', () => {
  it('401 when unauthenticated', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await POST(makeReq(new File(['x'], 'a.txt', { type: 'text/plain' })), ctx());
    expect(res.status).toBe(401);
  });

  it('413 when oversize', async () => {
    const big = new File([new Uint8Array(26 * 1024 * 1024)], 'a.pdf', { type: 'application/pdf' });
    const res = await POST(makeReq(big), ctx());
    expect(res.status).toBe(413);
  });

  it('415 when mime unsupported', async () => {
    const res = await POST(
      makeReq(new File(['x'], 'a.png', { type: 'image/png' })),
      ctx(),
    );
    expect(res.status).toBe(415);
  });
});
```

> The test only asserts the early validation paths because mocking the deep Kysely builder chain in unit tests is high-cost and low-signal. Happy-path and 409/duplicate paths are covered by the manual e2e in Task 13.

- [ ] **Step 3: Run tests**

Run: `pnpm test src/app/api/threads/\\[id\\]/documents/route.test.ts`
Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/threads/
git commit -m "feat(docs): upload + list routes (#4)"
```

---

## Task 8: Retrieval tools

**Goal:** Vercel AI SDK tool factory `createDocumentTools({ threadId })` exposing `search_corpus`, `get_chunk_neighbors`, `get_document_metadata`. All tools query `adminDb` and pre-filter by `threadId`.

**Files:**
- Create: `src/lib/ai/tools/documents.ts`
- Create: `src/lib/ai/tools/documents.test.ts`

**Acceptance Criteria:**
- [ ] `search_corpus` returns `[{ chunk_id, document_id, document_name, chunk_index, content, score }]` and runs vector + lexical halves in parallel.
- [ ] `get_chunk_neighbors` clamps before/after to `[0, 3]` and silently returns `[]` for cross-thread chunk ids.
- [ ] `get_document_metadata` returns `null` for cross-thread document ids.
- [ ] All tools enforce `documents.status='ready'`.

**Verify:** `pnpm test src/lib/ai/tools/documents.test.ts`

**Steps:**

- [ ] **Step 1: Implement**

```ts
// src/lib/ai/tools/documents.ts
import 'server-only';

import { tool } from 'ai';
import { sql } from 'kysely';
import { z } from 'zod';
import { adminDb } from '@/lib/db/admin';
import { embedChunks } from '@/lib/documents/embed';

const RRF_K = 60;
const HALF_LIMIT = 50;

export interface CreateDocumentToolsArgs {
  threadId: string;
}

export function createDocumentTools({ threadId }: CreateDocumentToolsArgs) {
  return {
    search_corpus: tool({
      description:
        'Hybrid (lexical + vector) search over the documents attached to this conversation. Returns top-k chunks with document name and a fused score. Prefer this over guessing when the user references attached material.',
      parameters: z.object({
        query: z.string().min(1).describe('Natural-language query.'),
        k: z.number().int().min(1).max(20).optional().describe('Top-k chunks to return (default 8).'),
      }),
      execute: async ({ query, k = 8 }) => {
        const [{ vectors }, lexRows] = await Promise.all([
          embedChunks([query]),
          adminDb
            .selectFrom('chunks as c')
            .innerJoin('documents as d', 'd.id', 'c.document_id')
            .select((eb) => [
              'c.id as chunk_id',
              'c.document_id',
              'd.name as document_name',
              'c.chunk_index',
              'c.content',
              eb
                .fn('ts_rank_cd', [
                  eb.ref('c.fts'),
                  sql`websearch_to_tsquery('english', ${query})`,
                ])
                .as('lex_rank'),
            ])
            .where('c.thread_id', '=', threadId)
            .where('d.status', '=', 'ready')
            .where(sql`c.fts`, '@@', sql`websearch_to_tsquery('english', ${query})`)
            .orderBy('lex_rank', 'desc')
            .limit(HALF_LIMIT)
            .execute(),
        ]);

        const queryVec = vectors[0];
        if (!queryVec) return { results: [] };
        const queryVecLit = `[${queryVec.join(',')}]`;
        const vecRows = await adminDb
          .selectFrom('chunks as c')
          .innerJoin('documents as d', 'd.id', 'c.document_id')
          .select([
            'c.id as chunk_id',
            'c.document_id',
            'd.name as document_name',
            'c.chunk_index',
            'c.content',
          ])
          .where('c.thread_id', '=', threadId)
          .where('d.status', '=', 'ready')
          .orderBy(sql`c.embedding <=> ${queryVecLit}::vector`)
          .limit(HALF_LIMIT)
          .execute();

        const fused = new Map<
          string,
          {
            chunk_id: string;
            document_id: string;
            document_name: string;
            chunk_index: number;
            content: string;
            score: number;
          }
        >();
        vecRows.forEach((r, i) => {
          fused.set(r.chunk_id, {
            chunk_id: r.chunk_id,
            document_id: r.document_id,
            document_name: r.document_name,
            chunk_index: r.chunk_index,
            content: r.content,
            score: 1 / (RRF_K + i + 1),
          });
        });
        lexRows.forEach((r, i) => {
          const prev = fused.get(r.chunk_id);
          const add = 1 / (RRF_K + i + 1);
          if (prev) prev.score += add;
          else
            fused.set(r.chunk_id, {
              chunk_id: r.chunk_id,
              document_id: r.document_id,
              document_name: r.document_name,
              chunk_index: r.chunk_index,
              content: r.content,
              score: add,
            });
        });

        const results = [...fused.values()]
          .sort((a, b) => b.score - a.score || (a.chunk_id < b.chunk_id ? 1 : -1))
          .slice(0, k);
        return { results };
      },
    }),

    get_chunk_neighbors: tool({
      description:
        "Return chunks adjacent to a given chunk in its source document. Use this to expand context around a chunk returned by search_corpus.",
      parameters: z.object({
        chunk_id: z.string(),
        before: z.number().int().min(0).max(3).optional(),
        after: z.number().int().min(0).max(3).optional(),
      }),
      execute: async ({ chunk_id, before = 1, after = 1 }) => {
        const root = await adminDb
          .selectFrom('chunks')
          .select(['document_id', 'chunk_index', 'thread_id'])
          .where('id', '=', chunk_id)
          .executeTakeFirst();
        if (!root || root.thread_id !== threadId) return { chunks: [] };
        const rows = await adminDb
          .selectFrom('chunks')
          .select(['id as chunk_id', 'document_id', 'chunk_index', 'content'])
          .where('document_id', '=', root.document_id)
          .where('chunk_index', '>=', root.chunk_index - before)
          .where('chunk_index', '<=', root.chunk_index + after)
          .orderBy('chunk_index', 'asc')
          .execute();
        return { chunks: rows };
      },
    }),

    get_document_metadata: tool({
      description: "Return name, kind, byte size, token count, and chunk count for an attached document.",
      parameters: z.object({ document_id: z.string() }),
      execute: async ({ document_id }) => {
        const row = await adminDb
          .selectFrom('documents')
          .select(['id', 'name', 'kind', 'byte_size', 'token_count', 'chunk_count', 'created_at'])
          .where('id', '=', document_id)
          .where('thread_id', '=', threadId)
          .where('status', '=', 'ready')
          .executeTakeFirst();
        return row ?? null;
      },
    }),
  };
}
```

- [ ] **Step 2: Tests**

```ts
// src/lib/ai/tools/documents.test.ts
import { describe, expect, it } from 'vitest';
import { createDocumentTools } from './documents';

describe('createDocumentTools', () => {
  it('returns three named tools', () => {
    const tools = createDocumentTools({ threadId: 't-1' });
    expect(Object.keys(tools).sort()).toEqual([
      'get_chunk_neighbors',
      'get_document_metadata',
      'search_corpus',
    ]);
  });

  it('search_corpus parameters include query and optional k', () => {
    const tools = createDocumentTools({ threadId: 't-1' });
    // tool() exposes the zod schema as `inputSchema` (AI SDK v6).
    const schema = (tools.search_corpus as { inputSchema: { parse: (v: unknown) => unknown } })
      .inputSchema;
    expect(() => schema.parse({ query: 'hi' })).not.toThrow();
    expect(() => schema.parse({ query: 'hi', k: 8 })).not.toThrow();
    expect(() => schema.parse({ query: '' })).toThrow();
    expect(() => schema.parse({ query: 'hi', k: 21 })).toThrow();
  });
});
```

> Functional behavior of the SQL queries is exercised end-to-end in Task 13. Unit-testing the query builder against mocked Kysely chains is high cost / low signal.

- [ ] **Step 3: Run tests**

Run: `pnpm test src/lib/ai/tools/documents.test.ts`
Expected: 2 passed. If `inputSchema` field name differs in the installed `ai` version, update the test to read whichever field the tool factory exposes (look at the installed `ai/dist` types).

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/
git commit -m "feat(docs): retrieval tools (search_corpus, neighbors, metadata) (#4)"
```

---

## Task 9: Wire tools + parts into chatStream

**Goal:** `chatStream` uses `createDocumentTools({ threadId })` with `streamText`, persists tool steps + final text into `messages.parts`, and continues to publish only text deltas to the realtime channel.

**Files:**
- Modify: `src/lib/inngest/functions.ts` (specifically the `chatStream` body)

**Acceptance Criteria:**
- [ ] `streamText` call includes `tools: createDocumentTools({ threadId })` and `stopWhen: stepCountIs(5)`.
- [ ] `result.fullStream` is consumed; text deltas continue to be published as `delta` realtime events.
- [ ] Tool calls and tool results are accumulated and persisted to `messages.parts` (jsonb) at finish.
- [ ] System prompt includes the document-tool nudge.

**Verify:** `pnpm typecheck` and a manual smoke run (Task 13).

**Steps:**

- [ ] **Step 1: Edit `chatStream` body**

Replace the section from `try {` through the success-path `await inngest.realtime.publish(channel.done, ...)` in `src/lib/inngest/functions.ts` with the following. Imports at the top of the file gain:

```ts
import { stepCountIs, streamText } from 'ai';
import { createDocumentTools } from '@/lib/ai/tools/documents';
```

(Drop the existing `streamText` import if duplicated.)

Inside `chatStream`, just before `streamText({...})`:

```ts
const tools = createDocumentTools({ threadId });

const SYSTEM_PROMPT =
  'You are a helpful assistant. ' +
  'Documents may be attached to this conversation. When the user references one, prefer calling search_corpus over guessing. ' +
  'Use get_chunk_neighbors to expand context around a relevant chunk. ' +
  'Use get_document_metadata only when the user asks about a document\'s structure.';
```

Replace the `streamText(...)` call with:

```ts
const result = streamText({
  model: anthropic(CLAUDE_MODEL),
  maxOutputTokens: MAX_TOKENS,
  system: SYSTEM_PROMPT,
  messages,
  tools,
  stopWhen: stepCountIs(5),
});
```

Replace the `for await (const text of result.textStream)` loop with a `fullStream` consumer that:
- forwards `text-delta` parts to `inngest.realtime.publish(channel.delta, { text })`,
- accumulates parts (text, tool-call, tool-result) into a `parts` array.

```ts
const parts: Array<Record<string, unknown>> = [];
let currentText = '';

for await (const part of result.fullStream) {
  if (part.type === 'text-delta') {
    const t = part.text;
    if (!t) continue;
    buffer += t;
    currentText += t;
    inngest.realtime.publish(channel.delta, { text: t }).catch((err) => {
      logger.warn('realtime delta publish failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
    const now = Date.now();
    if (now - lastFlushAt >= DEBOUNCE_MS && !pendingFlush) {
      pendingFlush = flush().finally(() => {
        pendingFlush = null;
      });
    }
  } else if (part.type === 'text-end' || part.type === 'finish-step') {
    if (currentText) {
      parts.push({ type: 'text', text: currentText });
      currentText = '';
    }
  } else if (part.type === 'tool-call') {
    parts.push({
      type: 'tool-call',
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      args: part.input,
    });
  } else if (part.type === 'tool-result') {
    parts.push({
      type: 'tool-result',
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      result: part.output,
    });
  } else if (part.type === 'error') {
    throw part.error;
  }
}
if (currentText) parts.push({ type: 'text', text: currentText });
```

Update the success-path persistence to include `parts`:

```ts
await adminDb
  .updateTable('messages')
  .set({
    content: buffer,
    parts: JSON.stringify(parts),
    completed_at: completedAt.toISOString(),
    finish_reason: finishReason ?? null,
    model: CLAUDE_MODEL,
    input_tokens: usage.inputTokens ?? null,
    output_tokens: usage.outputTokens ?? null,
    latency_ms: latencyMs,
    inngest_run_id: runId,
  })
  .where('id', '=', assistantMessageId)
  .execute();
```

> Note: AI SDK v6 part types — verify shape against the installed `ai` package's `FullStreamPart` type. If field names differ (e.g. `delta` vs `text` on `text-delta`), update the consumer accordingly. The branches and intent stay the same.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: passes. Address any field-name drift against the installed `ai` package types.

- [ ] **Step 3: Commit**

```bash
git add src/lib/inngest/functions.ts
git commit -m "feat(docs): wire retrieval tools + parts persistence into chatStream (#4)"
```

---

## Task 10: Document chip rail UI + realtime hook

**Goal:** A `DocumentChipRail` component that renders document chips (filename + state) and updates live via Supabase realtime.

**Files:**
- Create: `src/app/(authed)/chat/use-thread-documents.ts`
- Create: `src/app/(authed)/chat/document-chip-rail.tsx`

**Acceptance Criteria:**
- [ ] Hook returns `{ documents, refresh }` and subscribes to INSERT/UPDATE on `public.documents` filtered by `thread_id`.
- [ ] Component renders one chip per doc with a state icon (spinner/check/error) and shows `error_message` in a `title` tooltip on `failed`.

**Verify:** Manual — covered in Task 13.

**Steps:**

- [ ] **Step 1: Hook**

```ts
// src/app/(authed)/chat/use-thread-documents.ts
'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export interface ThreadDocument {
  id: string;
  name: string;
  kind: 'pdf' | 'docx' | 'md' | 'txt';
  byte_size: number;
  status: 'processing' | 'ready' | 'failed';
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  ready_at: string | null;
}

export function useThreadDocuments(threadId: string | null, initial: ThreadDocument[]) {
  const [documents, setDocuments] = useState<ThreadDocument[]>(initial);

  const refresh = useCallback(async () => {
    if (!threadId) return;
    const res = await fetch(`/api/threads/${threadId}/documents`);
    if (!res.ok) return;
    const body = (await res.json()) as { documents: ThreadDocument[] };
    setDocuments(body.documents);
  }, [threadId]);

  // Reset when thread changes.
  useEffect(() => {
    setDocuments(initial);
  }, [initial]);

  // Realtime: INSERT/UPDATE on documents filtered by thread.
  useEffect(() => {
    if (!threadId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`thread-documents:${threadId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'documents', filter: `thread_id=eq.${threadId}` },
        (payload) => {
          const row = payload.new as ThreadDocument;
          setDocuments((prev) => (prev.some((d) => d.id === row.id) ? prev : [...prev, row]));
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'documents', filter: `thread_id=eq.${threadId}` },
        (payload) => {
          const row = payload.new as ThreadDocument;
          setDocuments((prev) => prev.map((d) => (d.id === row.id ? row : d)));
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [threadId]);

  return { documents, refresh };
}
```

- [ ] **Step 2: Component**

```tsx
// src/app/(authed)/chat/document-chip-rail.tsx
'use client';

import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import type { ThreadDocument } from './use-thread-documents';

export function DocumentChipRail({ documents }: { documents: ThreadDocument[] }) {
  if (documents.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {documents.map((d) => (
        <span
          key={d.id}
          className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-1 text-xs"
          title={
            d.status === 'failed'
              ? d.error_message ?? d.error_code ?? 'Failed'
              : `${d.kind.toUpperCase()} · ${formatBytes(d.byte_size)}`
          }
        >
          {d.status === 'processing' && <Loader2 className="size-3 animate-spin" />}
          {d.status === 'ready' && <CheckCircle2 className="size-3 text-emerald-600" />}
          {d.status === 'failed' && <AlertCircle className="size-3 text-destructive" />}
          <span className="max-w-[16ch] truncate">{d.name}</span>
        </span>
      ))}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(authed)/chat/use-thread-documents.ts" "src/app/(authed)/chat/document-chip-rail.tsx"
git commit -m "feat(docs): chip rail + realtime hook (#4)"
```

---

## Task 11: SSR initial documents + composer integration

**Goal:** Page loads the thread's documents on the server. Composer gets a paperclip + drag-drop that POSTs to the upload route.

**Files:**
- Modify: `src/app/(authed)/chat/page.tsx`
- Modify: `src/app/(authed)/chat/chat-view.tsx`

**Acceptance Criteria:**
- [ ] Page passes `initialDocuments` to `<ChatView />`.
- [ ] Chat view shows the chip rail above the composer.
- [ ] Paperclip button opens file picker; selecting one or more files uploads each via `POST /api/threads/:id/documents`.
- [ ] Drag-and-drop onto the composer area uploads the dropped files.
- [ ] If there is no thread yet (new chat), the upload action is disabled with a tooltip "Send a message first to start a thread."

**Verify:** Manual smoke (Task 13).

**Steps:**

- [ ] **Step 1: SSR initial list in `page.tsx`**

In `src/app/(authed)/chat/page.tsx`, alongside the existing thread/messages SSR queries, fetch documents for the active thread (only if there is one):

```ts
const initialDocuments = activeThreadId
  ? (
      await adminDb
        .selectFrom('documents')
        .select(['id','name','kind','byte_size','status','error_code','error_message','created_at','ready_at'])
        .where('thread_id', '=', activeThreadId)
        .orderBy('created_at', 'asc')
        .execute()
    )
  : [];
```

Pass `initialDocuments={initialDocuments}` to `<ChatView />`.

- [ ] **Step 2: Update `ChatView` props + state**

In `src/app/(authed)/chat/chat-view.tsx`:

Add to `ChatViewProps`:

```ts
import type { ThreadDocument } from './use-thread-documents';
import { useThreadDocuments } from './use-thread-documents';
import { DocumentChipRail } from './document-chip-rail';
import { Paperclip } from 'lucide-react';
// ...
interface ChatViewProps {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  initialMessages: Message[];
  initialDocuments: ThreadDocument[];
}
```

Inside the component, wire the hook:

```ts
const { documents, refresh: refreshDocuments } = useThreadDocuments(threadId, initialDocuments);
```

- [ ] **Step 3: Add file-upload handlers**

```ts
const fileInputRef = useRef<HTMLInputElement | null>(null);

const uploadFiles = useCallback(
  async (files: FileList | File[]) => {
    if (!threadId) return; // disabled state handles UI
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.set('file', file);
      try {
        const res = await fetch(`/api/threads/${threadId}/documents`, {
          method: 'POST',
          body: fd,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError(`Upload failed: ${body?.error ?? res.status}`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed');
      }
    }
    // The realtime subscription will pick up new rows; this is belt-and-suspenders.
    void refreshDocuments();
  },
  [refreshDocuments, threadId],
);
```

- [ ] **Step 4: Render chip rail + paperclip**

Replace the existing `<form>` block with one that includes the paperclip button and a drag-and-drop wrapper:

```tsx
<DocumentChipRail documents={documents} />

<form
  className="flex gap-2"
  onSubmit={(e) => { e.preventDefault(); void send(); }}
  onDragOver={(e) => { e.preventDefault(); }}
  onDrop={(e) => {
    e.preventDefault();
    if (!threadId || !e.dataTransfer.files.length) return;
    void uploadFiles(e.dataTransfer.files);
  }}
>
  <input
    ref={fileInputRef}
    type="file"
    accept="application/pdf,.docx,.md,.txt,text/markdown,text/plain"
    multiple
    className="hidden"
    onChange={(e) => {
      if (e.target.files?.length) void uploadFiles(e.target.files);
      e.target.value = '';
    }}
  />
  <Button
    type="button"
    variant="ghost"
    size="icon"
    disabled={!threadId}
    title={threadId ? 'Attach document' : 'Send a message first to start a thread.'}
    onClick={() => fileInputRef.current?.click()}
  >
    <Paperclip className="size-4" />
  </Button>
  <label htmlFor={inputId} className="sr-only">Message</label>
  <input
    id={inputId}
    className="flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    placeholder="Type a message…"
    value={input}
    onChange={(e) => setInput(e.target.value)}
    disabled={status === 'streaming'}
  />
  {status === 'streaming' ? (
    <Button type="button" variant="outline" onClick={stop}>Stop</Button>
  ) : (
    <Button type="submit" disabled={!input.trim()}>Send</Button>
  )}
</form>
```

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(authed)/chat/"
git commit -m "feat(docs): paperclip + drag-drop upload integration with chip rail (#4)"
```

---

## Task 12: Render assistant `parts` in the message log

**Goal:** When `message.parts` is non-null, render the parts in order: text segments inline, tool calls/results in collapsed panels.

**Files:**
- Modify: `src/app/(authed)/chat/chat-view.tsx`
- Modify: `src/app/(authed)/chat/page.tsx` (pass `parts` through SSR)

**Acceptance Criteria:**
- [ ] SSR loads `messages.parts` and passes it to the view.
- [ ] Assistant messages with `parts != null` render text + collapsible tool panels (showing tool name, args, and result preview).
- [ ] Streaming-time messages still render via `text` (delta channel) and switch to `parts` rendering after the user reloads.

**Verify:** Manual smoke (Task 13).

**Steps:**

- [ ] **Step 1: Extend the `Message` type**

In `chat-view.tsx`:

```ts
type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: unknown }
  | { type: 'tool-result'; toolName: string; toolCallId: string; result: unknown };

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  parts: MessagePart[] | null;
}
```

Update every `setMessages` call site to set `parts: null` for optimistic placeholders. (Current call sites: send, regenerate, abort cleanups — same lines, just add the field.)

- [ ] **Step 2: Pass parts from SSR**

In `page.tsx`, the existing messages query already returns `content`. Add `parts`:

```ts
const messages = (
  await adminDb
    .selectFrom('messages')
    .select(['id', 'role', 'content', 'parts'])
    /* existing where/order */
    .execute()
).map((m) => ({
  id: m.id,
  role: m.role as 'user' | 'assistant' | 'system',
  text: m.content,
  parts: m.parts as MessagePart[] | null,
}));
```

- [ ] **Step 3: Render parts**

Replace the existing `<div className="whitespace-pre-wrap text-sm">…</div>` block with:

```tsx
<div className="flex flex-col gap-2 text-sm">
  {m.parts && m.role === 'assistant'
    ? m.parts.map((p, i) => {
        if (p.type === 'text') {
          return (
            <p key={i} className="whitespace-pre-wrap">{p.text}</p>
          );
        }
        if (p.type === 'tool-call') {
          return (
            <details key={i} className="rounded-md border bg-muted/40 p-2 text-xs">
              <summary className="cursor-pointer font-mono">
                ▶ {p.toolName}({JSON.stringify(p.args)})
              </summary>
            </details>
          );
        }
        return (
          <details key={i} className="rounded-md border bg-muted/40 p-2 text-xs">
            <summary className="cursor-pointer font-mono">↩ {p.toolName} result</summary>
            <pre className="mt-2 overflow-x-auto">{JSON.stringify(p.result, null, 2)}</pre>
          </details>
        );
      })
    : (
        <p className="whitespace-pre-wrap">
          {m.text || (m.role === 'assistant' && status === 'streaming' ? '…' : '')}
        </p>
      )}
</div>
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(authed)/chat/"
git commit -m "feat(docs): render messages.parts (tool calls + text) (#4)"
```

---

## Task 13: End-to-end manual smoke test

**Goal:** Verify the full happy path and the most important failure modes against a running stack.

**Files:** None (manual test, with optional ad-hoc fixture).

**Acceptance Criteria:** all checks below pass.

**Verify:** Manual.

**Steps:**

- [ ] **Step 1: Bring up the stack**

Run: `pnpm db:reset && pnpm dev`
Expected: Next + Inngest dev server come up; `/api/inngest` registers `chat-stream`, `chat-stream-timeout-cleanup`, and `document-ingest`.

- [ ] **Step 2: Sign in and open `/chat`**

In the browser, sign in (GitHub or `DEV_AUTH_ENABLED=1` form), open `/chat`, send a "hello" message to create a thread.

- [ ] **Step 3: Upload happy path**

Drag-and-drop a small TXT file (~5KB) onto the composer.
Expected:
- A chip appears immediately with a spinner.
- Within a few seconds, the chip flips to a green check.
- `select count(*) from chunks where thread_id = '<threadId>';` returns 1.
- `select status, token_count, chunk_count from documents where thread_id = '<threadId>';` shows `ready`, non-null counts.

Repeat with an MD file and a small DOCX (~100KB).
Expected: same end-state for each.

Repeat with a small text-extractable PDF (≤ ~500KB).
Expected: takes longer (Haiku call), but ends `ready`.

- [ ] **Step 4: Retrieval works**

In the chat, ask a question whose answer is uniquely in one of the uploaded docs (e.g. include a unique phrase you placed in the TXT file). Send the message.
Expected:
- Stream renders normally.
- After completion, reload the page; the assistant message renders with one or more `▶ search_corpus(...)` tool blocks containing the query, and the answer text mentions the unique phrase.

- [ ] **Step 5: Cross-thread isolation**

Create a second thread in the sidebar. Ask the same unique-phrase question there.
Expected: the agent does not surface content from the first thread's docs (verified by message text and by `messages.parts` showing empty `search_corpus` results or a tool that returns `{ chunks: [] }`).

- [ ] **Step 6: Validation surfaces**

- Upload a file > 25MB → toast/error shows `too_large`.
- Upload a `.png` → `unsupported_type`.
- Upload the same filename twice → second upload fails with `duplicate_name`.
- Upload 10 docs and try an 11th → `file_count_cap`.

- [ ] **Step 7: Failure surfaces**

Upload a known scanned (image-only) PDF.
Expected: chip flips to `failed` with an `extract_empty` tooltip.

- [ ] **Step 8: RLS check**

In the Supabase SQL editor as the anon role, with a JWT for user A, query `select * from documents where thread_id = '<user-B-thread>'`.
Expected: 0 rows.

- [ ] **Step 9: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: passes.

- [ ] **Step 10: Commit (notes-only)**

```bash
git commit --allow-empty -m "chore(docs): smoke test passed for #4"
```

---

## Self-review

**Spec coverage check:** every section of the spec is covered by at least one task.

- Architecture overview → Tasks 6, 7, 8, 9 (pipeline + tools + chat integration).
- Data model → Task 0.
- Limits → Task 6 (route enforcement) + Task 6 (chunk-step re-check via `documentIngest`).
- Pipeline / Upload route → Task 7. Pipeline / `documentIngest` → Task 6 (function), with deps in 2/3/4/5.
- Realtime status → Task 10.
- Retrieval tools → Task 8. Wiring into chat → Task 9.
- UI changes → Tasks 10, 11, 12.
- Dependencies / new infra → Task 1 + Task 0 (bucket).
- Verification → Task 13 covers the spec's verification list.

**Placeholder scan:** No "TODO" / "TBD" / "implement later" / vague handlers. Code blocks are present for every code step. Verification commands are exact.

**Type/name consistency:**
- `documentObjectPath` signature is consistent (Task 2 → Task 7).
- `chunkText`, `countTokens`, `Chunk` consistent (Task 3 → Task 6).
- `extractText`, `ExtractTooLargeError`, `ExtractEmptyError` consistent (Task 4 → Task 6).
- `embedChunks`, `EMBEDDING_MODEL` consistent (Task 5 → Task 6 / 8).
- `createDocumentTools` consistent (Task 8 → Task 9).
- `useThreadDocuments`, `ThreadDocument`, `DocumentChipRail` consistent (Task 10 → Task 11 → Task 12).
- `MessagePart` shape consistent (Task 9 persistence → Task 12 rendering).

**One known unknown:** the exact field names on `ai` SDK v6 stream parts (`text-delta` payload field, tool-call/tool-result field names). Task 9 calls this out and says: align to the installed package's types if they drift. Branches and intent stay the same.
