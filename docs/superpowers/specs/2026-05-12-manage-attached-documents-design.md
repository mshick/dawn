# Manage attached documents in a conversation

**Issue:** [#5 — Manage attached documents in a conversation](https://github.com/mshick/dawn/issues/5)
**Parent epic:** [#3 — Document upload and conversation grounding](https://github.com/mshick/dawn/issues/3)
**Date:** 2026-05-12
**Status:** Approved

## Summary

Let a user detach a previously-attached document from a conversation. After
detach, the document and all of its chunks are gone — the assistant's
retrieval tools can no longer surface its content. The list of currently
attached documents is already rendered by the chip rail introduced in #4;
this story adds the remove control, the API to back it, and the realtime
plumbing to update the rail across tabs.

## Resolutions of the open questions in #5

- **Hard delete vs soft delete → hard delete.** Aligns with the issue's
  "subsequent retrieval tool calls no longer return chunks" goal and the
  epic's "out of scope: re-attaching previously removed docs". Cascade FKs
  already exist on `chunks.document_id`. Tool-call results already
  persisted into `messages.parts` from earlier turns stay intact as
  conversational history — they're frozen JSON, not a live query. Storage
  blob is deleted too. Simpler invariant: a chunk exists ⇒ its document
  exists ⇒ retrieval can use it.
- **Confirmation prompt → yes.** Detach has no undo. A single ShadCN
  `AlertDialog` click-through prevents accidental loss.

## Goals

- A user can detach any document in the current conversation, regardless of
  its status (`processing` / `ready` / `failed`).
- After detach, subsequent `search_corpus` / `get_chunk_neighbors` /
  `get_document_metadata` calls return no results for that document.
- The chip rail updates across all tabs/devices viewing the conversation,
  without polling.
- Detach is owner-scoped — a user cannot detach a document on a thread they
  don't own.

## Non-goals

- Re-attaching a previously removed document from history.
- Editing or replacing extracted text.
- Multi-conversation document management or bulk operations (no "clear
  all").
- Cancelling an in-flight Inngest ingest run (we let it fail naturally on
  the missing FK).
- Cleaning up orphaned storage blobs from prior failures (future janitor
  job).

## Architecture overview

```
[browser] ──DELETE──▶ DELETE /api/threads/:id/documents/:documentId
                         │
                         ├─ auth: user owns thread (404 otherwise)
                         ├─ load documents row (verify thread_id match)
                         ├─ delete storage blob (best-effort, log on fail)
                         └─ delete documents row (cascades → chunks)

[browser, all tabs] ◀── supabase realtime DELETE on documents
                          (filter: thread_id=eq.:id) ── chip disappears
```

**Trust boundary** is unchanged from #4: the DELETE route validates the
authenticated user owns the thread, then uses `adminDb` (service role) for
the actual delete. Storage blob delete uses the same service-role client
as upload.

## Data model

**No migration.** The required cascades are already in place:

- `chunks.document_id … references public.documents(id) on delete cascade`
  (per `supabase/migrations/20260508000000_documents_schema.sql`).
- `documents` is published to `supabase_realtime` and has
  `replica identity full` (per `20260509000000_documents_replica_identity_full.sql`),
  so DELETE events carry the full `old` row including `id` for client-side
  row matching.
- RLS `documents_delete_own` policy already allows the owner to delete.
  We still go through the API for the explicit ownership check + storage
  blob cleanup.

## Components

### 1. `DELETE /api/threads/[id]/documents/[documentId]/route.ts` (new)

Co-located with the existing GET/POST handler. New nested dynamic segment
file.

Behavior:
1. Auth (`createClient().auth.getUser()`); 401 if no user.
2. Thread ownership check via `ensureOwned(threadId, user.id)` — reuse the
   helper from the existing route by hoisting it into a shared module
   (`src/app/api/threads/[id]/documents/_shared.ts`) so both routes import
   the same implementation. 404 if not owned.
3. Load `documents` by `id` AND `thread_id`. 404 if not found or thread
   mismatch (do not distinguish — same shape as `ensureOwned` failure, no
   information leak about which threads contain which document ids).
4. `deleteDocumentBlob(storage_path)` — best-effort. If it throws,
   `console.warn` with the path and continue. Rationale: an orphaned blob
   is recoverable by a future janitor; an orphaned DB row would leave the
   chip in the rail forever.
5. `adminDb.deleteFrom('documents').where('id', '=', documentId).execute()`
   — cascade removes chunks.
6. Return `204 No Content`.

Race with in-flight ingest is intentional and unhandled:
- If `documentIngest` is mid-extract/embed when the row is deleted, the
  final `index` step's `insert into chunks (…) values (…)` raises an FK
  violation. Inngest retries the step per its policy and ultimately marks
  the step failed. The status-flip step (`update documents set
  status='ready'`) updates zero rows. End state: document row gone,
  chunks never inserted. Consistent. No code change required.

### 2. `useThreadDocuments` hook (modify)

`src/app/(authed)/chat/use-thread-documents.ts`.

Two additions:

**Third realtime subscription** — same channel, third `.on('postgres_changes', { event: 'DELETE', … })` chained before `.subscribe()`. Handler reads `payload.old.id` and removes the matching row from local state. Because the documents table is `replica identity full`, `payload.old` is the entire row including `id`.

**`detach(documentId: string): Promise<void>` callback** returned from the hook alongside `documents` and `refresh`. Implementation:

1. Snapshot the chip being removed (for rollback).
2. Optimistically remove the chip from local state.
3. `fetch(`/api/threads/${threadId}/documents/${documentId}`, { method: 'DELETE' })`.
4. On non-2xx **and not 404**: restore the snapshotted chip and surface
   the error (toast). A 404 is treated as success — the row is already
   gone (e.g., another tab beat us to it).
5. On success: do nothing further; realtime will arrive and is a no-op
   because we already removed the row locally.

Optimistic update is needed because realtime delivery has ~tens-of-ms
latency; a chip that lingers after the user clicks "Detach" reads as
broken UI.

### 3. `DocumentChipRail` (modify)

`src/app/(authed)/chat/document-chip-rail.tsx`.

API change: takes a new prop `onDetach: (id: string) => void`.

Chip additions:
- A small `X` button (lucide `X` icon, size-3) appears on chip hover
  (`group-hover:opacity-100`, default `opacity-0`). Always visible on
  touch devices via `motion-reduce` / no-hover media query, and always
  visible on `status === 'failed'` chips (users are most likely to want
  to remove those).
- Clicking the `X` opens an `AlertDialog`:
  - Title: "Detach document"
  - Body: ``<name>` will be removed from this conversation. The
    assistant won't be able to retrieve from it after this. This can't
    be undone.``
  - Cancel button (default variant).
  - Confirm button: "Detach", destructive variant. On click: close
    dialog and call `onDetach(id)`.
- While a per-chip detach is in-flight (tracked by a local `pending` Set
  in the rail component), the X button is replaced by a `Loader2`
  spinner. This guards against double-clicks during the optimistic
  window.

Use the existing ShadCN `alert-dialog` primitive at
`src/components/ui/alert-dialog.tsx` (already installed).

### 4. `chat-view.tsx` (wire-up)

Pull `detach` out of `useThreadDocuments` and pass it as `onDetach` to
`DocumentChipRail`. No other changes.

## API contract

```
DELETE /api/threads/:threadId/documents/:documentId

200/204: success (204 No Content body).
401:     unauthenticated.
404:     thread not owned, document not in thread, or document already gone.

No request body. No response body on success.
```

## Edge cases

- **Detach during `processing`** — allowed. UI shows the X button on all
  statuses. The Inngest function's later steps fail on the missing FK and
  Inngest's retry budget consumes them; no orphan rows.
- **Storage blob delete fails** — logged, request still succeeds. Orphaned
  blob is acceptable (cheaper to leak storage than to leak chip rail
  state).
- **Two browsers detaching the same doc simultaneously** — first request
  wins; second returns 404. Hook treats 404 as success and the chip
  disappears in both. Realtime DELETE event reaches both tabs and is a
  no-op locally.
- **Detach mid-`search_corpus`** — retrieval tool's underlying query joins
  `documents` with `chunks` and filters on `documents.status = 'ready'`.
  Postgres MVCC ensures either the pre-delete snapshot (chunks present)
  or the post-delete snapshot (chunks gone) is returned, never a mix.
  Either way, no stale data leaks past the delete commit.
- **Detach a `failed` document** — same path; works identically. Failed
  docs have no chunks (the pipeline never reached `index`), so the
  cascade is a no-op on `chunks`.

## Verification

1. `pnpm typecheck` and `pnpm lint` pass.
2. Owner-only: upload a document as U1, attempt
   `DELETE /api/threads/<U1-thread>/documents/<doc-id>` while authenticated
   as U2 → 404. Switch to U1 → 204; chip disappears.
3. Cross-thread: upload doc to thread A, attempt to delete via thread B's
   URL → 404. Doc still present in thread A.
4. Cascade: upload doc, wait until `status='ready'`, capture
   `count(*) from chunks where document_id = $1` (should be > 0). Delete;
   re-run the count → 0.
5. Storage cleanup: after a successful delete, confirm the object at
   `{user_id}/{thread_id}/{document_id}.{ext}` is gone from the
   `documents` bucket.
6. Realtime: open the same thread in two browser tabs. Detach from tab A;
   chip disappears from tab B within ~1s without a refresh.
7. Confirmation: clicking the X opens the AlertDialog. Cancel keeps the
   chip; Detach removes it.
8. Optimistic + rollback: temporarily make the route return 500. Click
   Detach; chip vanishes then reappears with an error toast.
9. Retrieval cutoff: attach a doc with a known unique phrase, wait
   `ready`, confirm `search_corpus` returns a chunk containing the phrase.
   Detach. Re-ask the same question; confirm `search_corpus` returns
   zero hits referencing the phrase.
10. Detach during `processing`: upload a large doc; while still
    `processing`, detach it. Confirm the row is gone immediately and that
    the Inngest run eventually fails-fast without leaving chunks behind
    (`select count(*) from chunks where document_id = <id>` → 0).

## Risks / open items

- **Orphaned storage blobs** if blob delete fails. Tolerable; flagged for a
  future janitor task.
- **Inngest noise** from the FK-violation race during processing detach.
  Logged as a step failure in Inngest dashboard — informational, not
  alertable. If it becomes noisy in practice, we can add a pre-insert
  existence check in the `index` step.
