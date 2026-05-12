# Attach text documents to a conversation

**Issue:** [#4 — Attach text documents to a conversation](https://github.com/mshick/dawn/issues/4)
**Parent epic:** [#3 — Document upload and conversation grounding](https://github.com/mshick/dawn/issues/3)
**Date:** 2026-05-08
**Status:** Approved

## Summary

Let a user attach one or more text-extractable documents (PDF, DOCX, MD, TXT) to a single conversation, then have the assistant answer using their content. Documents are extracted, chunked, embedded, and indexed in an Inngest background pipeline; the assistant retrieves over them via three tools (hybrid search, neighbor lookup, document metadata) scoped to the current thread.

This is the first child of epic #3. It delivers the end-to-end happy path: upload → index → retrieve. Detach/manage UI (#5), upload progress polish (#6), and prompt-cache work (#7) are separate children.

## Goals

- A user can upload PDF, DOCX, MD, or TXT files in a conversation.
- Multi-document from day one — a single conversation can have several attached docs simultaneously.
- The assistant can retrieve relevant excerpts from attached docs on demand.
- Index state (`processing` / `ready` / `failed`) is visible to the user without polling.
- Conversation-scoped retrieval — tools cannot read another thread's documents, even by id.

## Non-goals

- Detaching / removing attached documents (issue #5).
- Detailed upload progress UI beyond a chip with three states (issue #6).
- Reuse of documents across conversations.
- Non-text file types (images, audio, video, scanned PDFs requiring OCR).
- Reranker on top of hybrid retrieval (deferred per epic).
- Cross-document or cross-conversation deduplication.
- Editing extracted text post-upload.

## Architecture overview

```
[browser] ──upload──▶ POST /api/threads/:id/documents
                       │
                       ├─ validate (size, mime, count, per-conv token budget pre-check)
                       ├─ store original in Supabase Storage (private bucket)
                       ├─ insert documents row (status='processing')
                       └─ inngest.send('document/ingest.requested', { documentId })
                                                                │
                                            ┌───────────────────┘
                                            ▼
                              Inngest fn: documentIngest
                              ├─ step: extract       (PDF→Haiku, DOCX→mammoth, MD/TXT→raw)
                              ├─ step: chunk         (cl100k_base, 800/100, single chunk if <2000)
                              ├─ step: embed         (OpenAI text-embedding-3-small, batch 96)
                              ├─ step: index         (insert chunks rows; tsvector generated col)
                              └─ flip status='ready' (or 'failed' with error_code/error_message)

[browser] ◀──supabase realtime──── chip flips processing → ready / failed

[chat send] ──▶ /api/chat ──▶ inngest chatStream
                                 │
                                 └─ streamText({ tools: { search_corpus,
                                                          get_chunk_neighbors,
                                                          get_document_metadata } })
                                       (tools query adminDb, scoped to thread_id;
                                        only ready docs)
```

**Trust boundary** is unchanged from today: `/api/chat` and `/api/threads/:id/documents` validate the user owns the thread; downstream Inngest functions use `adminDb` (service role) and pre-filter by `thread_id` for every tool call. The model never sees `thread_id` — it's bound in the tool factory closure.

## Data model

A new migration adds `pgvector`, two tables (`documents`, `chunks`), and one column (`messages.parts`).

```sql
-- pgvector
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
  embedding_model text not null,                    -- e.g. 'text-embedding-3-small'
  fts             tsvector generated always as (to_tsvector('english', content)) stored,
  created_at      timestamptz not null default now(),
  unique (document_id, chunk_index)
);
create index chunks_thread_id_idx        on public.chunks (thread_id);
create index chunks_embedding_model_idx  on public.chunks (embedding_model);
create index chunks_fts_gin              on public.chunks using gin (fts);
create index chunks_embedding_hnsw       on public.chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- messages: tool-call persistence column
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
-- chunks inserts/updates/deletes go through service role (Inngest); no client policy.
```

Notes:

- `thread_id` is denormalized onto `chunks` so retrieval tools can scope without an extra join.
- `embedding_model` lives on `chunks` (truth-of-state next to the vector). All chunks of a single document will share a model in v1, but the per-row column lets a future re-embed migration find affected rows in O(log n).
- Vector dim pinned to 1536 (`text-embedding-3-small` default). A future model swap to a different dim will need a parallel column + HNSW rebuild — flagged in Risks.
- HNSW chosen over IVFFlat: no training step, better recall at our scale (≤ ~1k chunks/conversation under the v1 caps). Defaults `m=16, ef_construction=64`.
- `unique (thread_id, name)` is enforced so duplicate filename uploads return a clear 409 rather than silently shadowing.
- `messages.parts jsonb` is added now because tool calls/results need to be persisted alongside text for the chat to render correctly on reload. Legacy rows have `parts = null` and the renderer falls back to `content`.

### Storage bucket

A new private Supabase Storage bucket `documents`. Object key pattern: `{user_id}/{thread_id}/{document_id}.{ext}`. Bucket policy:

- Authenticated users can `select` their own `{auth.uid()}/...` prefix.
- All writes/deletes go through server code with the service role.

## Limits

Enforced at the upload route (file count + size) and at the chunking step (per-conversation token cap):

- 25 MB per file.
- 10 files per conversation.
- 500k tokens of extracted text per conversation (sum of `documents.token_count` for `status='ready'` rows in the thread).

A pre-check on the route uses `byte_size / 3` as a generous token estimate to early-fail uploads that obviously won't fit. True enforcement happens after extraction; if a doc would push the conversation over the cap, it is marked `failed` with `error_code='conversation_token_cap'`.

## Pipeline detail

### 1. Upload route — `POST /api/threads/:id/documents`

App Router handler. `multipart/form-data`, single field `file`. Multiple uploads = N requests in parallel from the client.

Validation order:
1. Auth: user owns `thread_id`. Otherwise 404 (do not distinguish from "thread does not exist").
2. File count: existing non-`failed` docs in the thread < 10. Otherwise 409 `error_code='file_count_cap'`.
3. Size: `byte_size <= 25 * 1024 * 1024`. Otherwise 413 `error_code='too_large'`.
4. Mime + extension: `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (DOCX), `text/markdown`, `text/plain`. Otherwise 415 `error_code='unsupported_type'`.
5. Duplicate name: `unique (thread_id, name)`. Otherwise 409 `error_code='duplicate_name'`.
6. Token budget pre-check: `(sum_existing_token_count + byte_size / 3) <= 500_000`. Otherwise 409 `error_code='conversation_token_cap'`.

On success:
1. Generate `document_id` server-side.
2. Upload original to `documents` bucket at `{user_id}/{thread_id}/{document_id}.{ext}` via the Supabase service-role client.
3. Insert `documents` row (`status='processing'`, `token_count=null`, `chunk_count=null`).
4. `inngest.send('document/ingest.requested', { documentId })`.
5. Return `{ document: { id, name, kind, byte_size, status, created_at } }`.

If any step after the storage upload fails, attempt to delete the uploaded blob. If that delete fails it's left to manual cleanup; we do not wrap the multistep upload in a transaction.

### 2. Read route — `GET /api/threads/:id/documents`

Returns the list of attached documents for the thread (used for SSR/initial render of the chip rail). Owner-validated. Supabase RLS would also enforce this, but we keep the explicit check at the route to fail closed.

### 3. Inngest function — `documentIngest`

Triggered by `document/ingest.requested`. Steps (each retried independently by Inngest on transient failures):

**`extract`**
- Read original bytes from Supabase Storage via the service-role client.
- PDF: `@ai-sdk/anthropic` `generateText` with `claude-haiku-4-5-20251001`, PDF as a `file` content block. System prompt: "Extract all text from this PDF in reading order. Preserve paragraph breaks. Do not summarize, comment, or add anything." Single call; no PDF splitting in v1. If `finishReason === 'length'`, mark `failed` with `error_code='extract_too_large'`.
- DOCX: `mammoth.extractRawText({ buffer })`.
- MD / TXT: `new TextDecoder('utf-8').decode(bytes)`.
- Returns `{ text }`.

If extraction returns < 50 characters of text for a file > 100KB, mark `failed` with `error_code='extract_empty'` (typical signal of a scanned PDF).

**`chunk`**
- Token-count the full extracted text using `js-tiktoken` (`cl100k_base`).
- If `total_tokens < 2000`: emit one chunk with the full text.
- Else split into 800-token windows with 100-token overlap. Snap each chunk's end boundary to the nearest paragraph break (`\n\n`) within ±50 tokens; if none, snap to the nearest sentence boundary (`. `, `! `, `? `); else hard cut.
- Re-check the conversation token budget: `existing_total + total_tokens <= 500_000`. Else mark `failed` with `error_code='conversation_token_cap'`.
- Returns `[{ chunk_index, content, token_count }]`.

**`embed`**
- OpenAI `embeddings.create({ model: 'text-embedding-3-small', input: <batch of contents> })`.
- Batches of 96 chunks per request (well under the 2048 input cap, keeps retry units small).
- Returns parallel array of 1536-dim vectors.

**`index`**
- Insert all `chunks` rows in a single transactional batch via `adminDb`. `embedding_model = 'text-embedding-3-small'`.
- Update `documents` row: `status='ready'`, `token_count`, `chunk_count`, `ready_at = now()`.

**Failure handling:**
- Each step's final-failure handler (post-Inngest-retries) sets `documents.status='failed'`, populates `error_code` and a redacted `error_message`, and returns. No partial chunks are persisted — `index` runs only after `embed` succeeds.

**Concurrency:** function declares `concurrency: { limit: 5 }` to stay under default OpenAI TPM during bulk uploads.

### 4. Realtime status

The chip rail subscribes to Supabase realtime `postgres_changes` on `documents` filtered by `thread_id`, listening for both `INSERT` and `UPDATE` events. `INSERT` adds a chip in `processing`; `UPDATE` transitions state (most importantly `processing → ready` and `processing → failed`). No polling. The subscription is scoped per-thread and torn down on thread switch / unmount.

### 5. Retrieval tools

Defined as Vercel AI SDK tools in `src/lib/inngest/tools/documents.ts`. Factory function:

```ts
export function createDocumentTools({ threadId }: { threadId: string }) {
  return {
    search_corpus: tool({ /* ... */ }),
    get_chunk_neighbors: tool({ /* ... */ }),
    get_document_metadata: tool({ /* ... */ }),
  };
}
```

`threadId` lives in the closure; it is never a tool parameter. Every tool runs `where thread_id = $threadId and documents.status = 'ready'`.

**`search_corpus(query: string, k?: number)`** — hybrid search.
- `k` defaults to 8, clamped to `[1, 20]`.
- Vector half: query embedding via `text-embedding-3-small`, `order by chunks.embedding <=> $query_embedding limit 50`.
- Lexical half: `where chunks.fts @@ websearch_to_tsquery('english', $query) order by ts_rank_cd(chunks.fts, websearch_to_tsquery('english', $query)) desc limit 50`.
- Fusion: Reciprocal Rank Fusion. `score = 1/(60+rank_vec) + 1/(60+rank_lex)`. Take top-k by fused score. Ties broken by `chunks.id` desc (UUIDv7, so newer chunks win).
- Returns `[{ chunk_id, document_id, document_name, chunk_index, content, score }]`.
- Both halves run in parallel with `Promise.all`.

**`get_chunk_neighbors(chunk_id: string, before?: number, after?: number)`** — context expansion.
- `before`, `after` default to 1, clamped to `[0, 3]`.
- Resolves `chunk_id` to `(document_id, chunk_index, thread_id)`. If `thread_id !== closure.threadId`, returns `[]` (do not error — quiet failure prevents oracle attacks).
- Returns chunks where `document_id = $doc_id and chunk_index between $idx-before and $idx+after`, ordered by `chunk_index`.

**`get_document_metadata(document_id: string)`** — top-level info.
- Verifies `documents.thread_id = closure.threadId and status = 'ready'`. If not, returns `null`.
- Returns `{ id, name, kind, byte_size, token_count, chunk_count, created_at }`.

**System prompt nudge** (added to the existing system message):
> Documents may be attached to this conversation. When the user references one, prefer calling `search_corpus` over guessing. Use `get_chunk_neighbors` to expand context around a relevant chunk. Use `get_document_metadata` only when the user asks about a document's structure.

### 6. `chatStream` integration

`chatStream` (in `src/lib/inngest/functions.ts`) gains:

- A call to `createDocumentTools({ threadId })` before invoking `streamText`.
- `streamText({ ..., tools, stopWhen: stepCountIs(5) })` (or AI-SDK-v6 equivalent multi-step helper, confirmed at implementation time).
- Tool steps and final assistant text are persisted into `messages.parts` (jsonb array of `{ type: 'text' | 'tool-call' | 'tool-result', ... }` matching the AI SDK's `UIMessage` parts shape). Streaming text deltas continue to flush to `messages.content` for backward-compatible rendering and for the realtime delta channel, which only carries text.

Tool-call telemetry (counts, names, latencies) goes into the existing telemetry columns where it fits; for v1 no new columns are added beyond `parts`.

### 7. UI changes (`chat-view.tsx`)

- Paperclip icon button left of the composer; opens file picker (`accept="application/pdf,.docx,.md,.txt"`).
- Drag-and-drop onto the composer area also accepted; both paths funnel into the same per-file `POST /api/threads/:id/documents` request.
- Above the composer: a horizontal chip rail. Each chip shows filename + state icon (spinner / check / error). Failed chips show their `error_message` in a tooltip.
- Chip rail subscribes to Supabase realtime on `documents` for the current `thread_id`; on `INSERT` it adds a chip in `processing`, on `UPDATE` it transitions state.
- No detach control in v1 (issue #5).
- Renderer for assistant messages: if `parts != null`, render parts in order (text + collapsed tool-call/result blocks). If `parts == null`, fall back to `content`.

## Dependencies / new infrastructure

- **New npm deps:** `mammoth`, `js-tiktoken`, `openai`.
- **New env var:** `OPENAI_API_KEY` (added to `.env.example` and `src/lib/env.ts` Zod schema).
- **New Supabase Storage bucket:** `documents` (private). Bucket creation goes in the migration or `scripts/bootstrap.mjs` — final placement decided at implementation time.
- **New Inngest function:** `documentIngest` registered in `src/lib/inngest/functions.ts`, served by the existing `/api/inngest` handler.

## Verification

1. `pnpm db:reset` runs cleanly; new tables, indexes, and storage bucket exist.
2. `pnpm generate` produces typed entries for `documents`, `chunks`, and `messages.parts`. `pnpm typecheck` and `pnpm lint` pass.
3. Upload happy path: upload one of each kind (PDF, DOCX, MD, TXT). Each chip transitions `processing → ready` without polling. After ready, `select count(*) from public.chunks where document_id = $1` matches `documents.chunk_count`.
4. Validation: oversize → 413; bad mime → 415; 11th file → 409; duplicate name → 409.
5. Retrieval: in a conversation with a known doc, ask a question whose answer requires a specific quoted phrase. Inspect `messages.parts` and confirm `search_corpus` was called with a sensible query, returned a chunk containing the phrase, and the assistant's reply uses the chunk content.
6. Cross-thread isolation: open two threads, attach docs to each. From thread A, the assistant's `search_corpus` cannot return a chunk from thread B (verified by content comparison and by `messages.parts` inspection).
7. RLS: as user U1, attempt `select * from documents where thread_id = <U2's thread>` via the Supabase client — returns 0 rows.
8. Failure surfaces: upload an image PDF (scanned) and confirm it ends `failed` with `error_code='extract_empty'` and the chip shows the error.
9. Conversation token cap: upload a doc that nearly fills the budget, then upload one that would push over — second one ends `failed` with `error_code='conversation_token_cap'`.

## Risks / open items

- **Haiku PDF extraction quality:** scanned/image-only PDFs return very little text. Out of scope per epic; we mark such docs `failed` with `error_code='extract_empty'`.
- **HNSW vs IVFFlat at scale:** HNSW is fine at v1 caps (≤ ~1k chunks/conversation). Revisit if a single thread ever exceeds ~50k chunks.
- **Tool persistence (`messages.parts`):** new column expands the chat render path. Justified because retrieval tool results are useful evidence on reload. Legacy rows render via `content` fallback.
- **Embedding model swap:** `embedding_model` is per chunk, but vector dim is fixed at 1536. A future swap to a different-dim model needs a parallel column + HNSW rebuild migration.
- **Rate limits:** OpenAI embedding TPM is reachable on bulk uploads. `documentIngest` declares `concurrency: { limit: 5 }` in v1. If users routinely upload more than ~5 large docs at once we'll add a rate-limited inner queue.
- **Supabase realtime feature flag:** `postgres_changes` requires the realtime publication to include the `documents` table. The migration must `alter publication supabase_realtime add table public.documents` (verified at implementation time).
- **PDF page-count cap (implicit):** the 25 MB file cap and Haiku's max output bound the page count we'll handle. We do not split a single PDF across multiple Haiku calls in v1; the failure mode (`extract_too_large`) is explicit.
