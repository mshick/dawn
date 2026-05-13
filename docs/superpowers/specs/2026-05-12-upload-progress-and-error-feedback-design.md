# Upload progress and error feedback

**Issue:** [#6 — Upload progress and error feedback](https://github.com/mshick/dawn/issues/6)
**Parent epic:** [#3 — Document upload and conversation grounding](https://github.com/mshick/dawn/issues/3)
**Date:** 2026-05-12
**Status:** Approved

## Summary

Today the chat already tracks per-document state (`processing` / `ready` /
`failed`) and the chip rail renders a spinner / check / error icon for each
attached document. The plumbing is there, but the user experience around it is
thin:

- A file the user just picked is **invisible** until the API returns 201 and
  the realtime `INSERT` fires. On large files or slow connections, that's a
  multi-second gap with no feedback.
- When upload-time validation fails (too large, unsupported, duplicate, file
  cap, token cap), the only feedback is a shared `error` banner that **shows
  the raw error code** (`too_large`, `conversation_token_cap`, …) and gets
  overwritten by the next failure.
- When pipeline processing fails (`extract_empty`, `extract_too_large`,
  `embed_failed`, …), the chip tooltip shows the **raw error_message** from
  the underlying library, which is rarely a sentence a user can act on.

This story closes those gaps. The chip rail becomes the single source of
truth for per-document state — including files that never made it past
client-side / route-level validation — and every state is rendered with a
clear, action-oriented English message.

## Goals

- The user sees a chip the moment they pick a file (or drop one), not when
  the network round-trip completes.
- Validation failures at the API surface as a `failed` chip on the rail with
  a clear, action-oriented message. They do not silently vanish, and they
  don't conflate with chat-streaming errors.
- Pipeline failures (extract / embed / index / token-cap) render with a
  human message instead of a raw error code.
- The user can dismiss a failed chip without leaving the conversation.
- Unsupported file types and oversize files are flagged client-side too —
  no need to wait for the server to know we can't accept the file.

## Non-goals

- Retries (re-running the ingest pipeline). Out of scope per the issue.
- Background re-processing.
- Detailed sub-stage progress (extracting / chunking / embedding /
  indexing) — coarse `processing` / `ready` / `failed` stays.
- Per-byte upload progress bars. The optimistic chip is enough; a spinner
  conveys "in flight" without HTTP `progress` plumbing.
- Telemetry / observability dashboards.
- Drag-and-drop visual drop-zone polish (separate UX iteration).

## Resolutions of open questions in the issue

- **Size limit?** Already set in #4: 25 MB per file, 10 files per
  conversation, 500k tokens of extracted text per conversation. No change
  here.
- **Visible sub-stages?** Stay coarse (`processing` / `ready` / `failed`).
  The Inngest pipeline classifies failures into specific codes that map to
  specific messages, but the rail icon is one of three.
- **Failures recoverable in-place?** No. Per the issue's out-of-scope
  bullet, the only "recovery" is dismiss-and-reupload.

## Architecture overview

```
File picker / drop ──▶ uploadFiles()
                         │
                         ├─ client-side pre-check (kind, size)
                         │    └─ rejected ──▶ add client-failed chip ──▶ rail
                         │
                         └─ POST /api/threads/:id/documents
                              │
                              ├─ 201 ──▶ realtime INSERT delivers row ──▶ rail
                              │            (optimistic chip drops out as the
                              │             real row arrives by id match)
                              │
                              └─ 4xx ──▶ add client-failed chip ──▶ rail
                                          (key by client-only id; carries
                                           friendly message)
```

Three sources of chip state, merged in `useThreadDocuments`:

1. **Server documents** — rows from `GET /api/threads/:id/documents` plus
   realtime `INSERT`/`UPDATE`/`DELETE`. Unchanged.
2. **Pending uploads** — client-side optimistic chips for files currently
   being POSTed. Shown with a `pending` status; dropped once the server row
   for the same upload arrives (matched by client id → server id).
3. **Client-rejected uploads** — client-side chips for files that failed
   pre-check or failed at the route. Stay on the rail until the user
   dismisses them. They are not persisted across reloads — they're a
   transient surface for "this attempt didn't make it".

The chip rail still renders one flat list. The new statuses (`pending` and
client-rejected) are styled the same as the existing ones (spinner for
in-flight, error icon for failed); the user doesn't need to know there are
two backing stores.

## Components

### 1. Error-message dictionary

`src/lib/documents/error-messages.ts` — exports a single function:

```ts
export function uploadErrorMessage(code: string): string
```

It maps every known `error_code` (from the API route and the Inngest
pipeline) to a one-sentence, action-oriented English message. Used by:

- `DocumentChipRail` for failed chips (tooltip + inline).
- `useThreadDocuments.uploadFiles` for client-rejected uploads.

Unknown codes get a generic "Upload failed. Please try again." message; the
raw `error_message` (if present) is kept available for the tooltip's
secondary line so power users can still see what blew up.

Initial mapping:

| `error_code`              | Message                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `too_large`               | Files must be 25 MB or smaller.                                                                |
| `unsupported_type`        | Unsupported file type — try PDF, DOCX, Markdown, or plain text.                                |
| `file_count_cap`          | This conversation already has 10 documents attached.                                           |
| `conversation_token_cap`  | This conversation is full. Detach a document to make room.                                     |
| `duplicate_name`          | A document with this name is already attached.                                                 |
| `invalid_body`            | Couldn't read the file. Try a different one.                                                   |
| `extract_empty`           | Couldn't extract any text — the file may be scanned or empty.                                  |
| `extract_too_large`       | Document is too long to process. Try splitting it into smaller files.                          |
| `embed_failed`            | Processing failed. Try uploading again.                                                        |
| `unauthorized` / `not_found` | Sign in again and reload the page. _(edge case — auth dropped mid-session)_              |
| _(default)_               | Upload failed. Please try again.                                                               |

Tests pin the message text for every known code, so a future code addition
in either the route or the Inngest function fails CI until a message is
added.

### 2. Client-side pre-check

`uploadFiles` in `chat-view.tsx` (or a small extracted helper) runs two
checks **before** POSTing, so the user gets a chip immediately and we save a
round-trip:

- **Size**: `file.size > 25 * 1024 * 1024` → reject with `too_large`.
- **Kind**: extension/mime not in the supported set → reject with
  `unsupported_type`.

Other route-level errors (`file_count_cap`, `conversation_token_cap`,
`duplicate_name`) require server knowledge and stay server-side. Pre-checks
exist purely for UX latency, not security — the server still enforces them
authoritatively.

### 3. Pending and rejected uploads in `useThreadDocuments`

The hook gains two new pieces of internal state:

```ts
interface PendingUpload {
  clientId: string;
  name: string;
  kind: 'pdf' | 'docx' | 'md' | 'txt' | 'other';
  byte_size: number;
  status: 'pending';        // optimistic, in-flight
  created_at: string;       // for ordering
}

interface RejectedUpload {
  clientId: string;
  name: string;
  kind: 'pdf' | 'docx' | 'md' | 'txt' | 'other';
  byte_size: number;
  status: 'failed';         // chip renders like a server-failed doc
  error_code: string;
  error_message: string | null;
  created_at: string;
}
```

The hook exports:

- `documents` — flat array, server rows + pending + rejected, ordered by
  `created_at` ascending so chips don't jump.
- `upload(files: FileList | File[])` — replaces `uploadFiles` from
  `chat-view.tsx`. Owns the pre-check, the POST, the optimistic chip, and
  the rejection path. The pending entry is removed once the server's `INSERT`
  realtime event arrives for the matching `document.id` (the POST response
  is awaited; the response body's `document.id` becomes the link between
  the pending chip and the server row).
- `dismiss(clientId | documentId)` — for failed chips. If it's a
  `RejectedUpload`, drop it from local state. If it's a server doc, calls
  `DELETE` (today's `detach`). The chip rail uses one handler; the hook
  routes by id source.

The rationale for keeping pending + rejected in the hook (rather than in
`chat-view.tsx`) is that the rail's union state belongs with the rail's
data source — and tests get a single seam.

### 4. Chip rail extensions

`DocumentChipRail` already handles `processing` / `ready` / `failed`. Three
small additions:

- A `pending` status renders the same as `processing` (spinner + name) so
  the visual is continuous as the upload transitions from client-pending to
  server-`processing`.
- Failed chips display the message text **inline below the rail** in
  addition to the tooltip, with the chip's name prefixed. Tooltips are not
  great for accessibility or for users who never hover; the inline line is
  the canonical place. Multiple failed chips → multiple lines.
- Failed-chip dismissal works for both rejected and server rows. For
  rejected uploads, no confirm dialog (nothing to lose); for server rows,
  the existing detach-confirm flow stays.

### 5. Removal of the shared upload-error banner

`chat-view.tsx` currently sets `error` for both chat-stream failures and
upload failures, which means they overwrite each other. Upload failures
move entirely into the chip rail. `error` continues to surface
chat-stream errors only (no behavior change there).

## Data flow — happy path

1. User picks `report.pdf`. Pre-check passes.
2. Hook generates `clientId = "pending-<uuid>"`, appends a pending entry to
   local state. Rail renders a spinner chip immediately.
3. Hook POSTs to `/api/threads/:id/documents`. Server validates, creates row
   `docId`, returns 201 with `{ document: { id: docId, ... } }`.
4. Realtime delivers `INSERT` for `docId`. Hook merges: remove the pending
   entry, add the server row. (If realtime is slow, the 201 response body
   is used as a fallback insert — the realtime event becomes a no-op when
   the row is already present.)
5. Inngest pipeline runs; `documents.status` flips `processing → ready`.
   Realtime `UPDATE` fires; the chip's icon swaps to a check.

## Data flow — client-rejected (oversize PDF)

1. User picks `huge.pdf`, 80 MB.
2. Pre-check rejects: `error_code = 'too_large'`.
3. Hook appends a `RejectedUpload` to local state. Rail shows a failed
   chip with "Files must be 25 MB or smaller." Network request is **not**
   sent.
4. User clicks ✕ to dismiss. Local state drops the entry.

## Data flow — server-rejected (duplicate name)

1. Pre-check passes. POST fires.
2. Server returns 409 `{ error: "duplicate_name" }`.
3. Hook converts to a `RejectedUpload` (drops the pending entry, adds the
   rejected one). Chip swaps in place from spinner to error.
4. User dismisses; or renames the file and re-uploads.

## Data flow — pipeline failure (`extract_empty`)

Unchanged from today; only the rendering changes:

1. Server row exists, status `processing`, chip shows spinner.
2. Inngest's classifier sets `status='failed'`, `error_code='extract_empty'`,
   `error_message='Extracted text under 50 chars for a 2 MB file'` (raw).
3. Realtime `UPDATE` arrives. Chip flips to error.
4. Rail renders `uploadErrorMessage('extract_empty')` →
   "Couldn't extract any text — the file may be scanned or empty." The raw
   `error_message` is kept as the tooltip's secondary line for debugging.

## Files touched

- `src/lib/documents/error-messages.ts` — **new**. Code → message dictionary.
- `src/lib/documents/error-messages.test.ts` — **new**. Pins messages, asserts
  no known code falls through to the default.
- `src/app/(authed)/chat/use-thread-documents.ts` — adds `PendingUpload` and
  `RejectedUpload` state, the new `upload(files)` method, `dismiss(id)`
  method, and the union ordering. Existing `refresh` and `detach` survive
  (`detach` becomes part of `dismiss`).
- `src/app/(authed)/chat/document-chip-rail.tsx` — handles `pending` status,
  renders inline failed-message line under the rail, threads dismiss for
  rejected vs server rows. Uses `uploadErrorMessage` for failed-chip text.
- `src/app/(authed)/chat/chat-view.tsx` — `uploadFiles` shrinks to
  `documents.upload(files)`; shared `error` state no longer set by upload
  failures.
- `src/app/(authed)/chat/document-chip-rail.test.tsx` — extends to cover
  pending chips and inline failed messages.

No DB migrations. No new dependencies. No new env vars.

## Validation rules — single source for client + server

The route remains authoritative. The client-side pre-check is a thin
duplicate of two specific rules (size, kind) — values are exported from a
small shared module so the two sides stay in step:

`src/lib/documents/upload-limits.ts` — **new**:

```ts
export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_DOCS_PER_THREAD = 10;
export const CONVERSATION_TOKEN_CAP = 500_000;
export const SUPPORTED_MIME = new Map<string, 'pdf' | 'docx' | 'md' | 'txt'>([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['text/markdown', 'md'],
  ['text/plain', 'txt'],
]);
export const SUPPORTED_EXTENSIONS = ['pdf', 'docx', 'md', 'txt', 'markdown', 'text'] as const;
```

The route imports the same constants (replacing the inline literals it has
today). The hook imports them for the pre-check. The Inngest function
already imports its own `CONVERSATION_TOKEN_CAP` constant — that file moves
to the shared module too.

## Verification

1. **Pre-check rejection.** Drag a 30 MB PDF. A failed chip appears
   immediately (no network request fired — verified via DevTools). The chip
   shows "Files must be 25 MB or smaller." User can dismiss.
2. **Pre-check rejection — wrong type.** Drag a `.png`. Same UX, message
   "Unsupported file type — try PDF, DOCX, Markdown, or plain text."
3. **Optimistic chip.** Pick a valid 1 KB `.txt`. A spinner chip appears
   immediately (throttle network in DevTools to make it observable). The
   chip transitions seamlessly to processing → ready without a flash of
   missing state.
4. **Duplicate name.** Upload `foo.txt`. Wait for ready. Upload `foo.txt`
   again. Spinner chip turns into a failed chip with "A document with this
   name is already attached." Dismiss → chip gone, original `foo.txt`
   untouched.
5. **File cap.** Attach 10 files. The 11th upload yields a failed chip with
   "This conversation already has 10 documents attached."
6. **Token cap.** Attach a doc that nearly fills the budget, then a doc that
   pushes over: failed chip with "This conversation is full. Detach a
   document to make room."
7. **Pipeline failure — empty extraction.** Upload an image-only PDF (sample
   in test assets). Chip eventually flips to failed with "Couldn't extract
   any text — the file may be scanned or empty."
8. **Chat error isolation.** While an upload is in flight, send a chat
   message that triggers a stream error. The chat error banner shows; the
   upload chip is unaffected.
9. **Reload.** Reload mid-pipeline. Server `processing` chips are restored;
   client-side pending and rejected entries are gone (expected — they're
   transient).
10. **Unit:** `uploadErrorMessage` returns a known message for every code
    emitted by the route handler (`too_large`, `unsupported_type`,
    `file_count_cap`, `conversation_token_cap`, `duplicate_name`,
    `invalid_body`) and by the Inngest classifier (`extract_empty`,
    `extract_too_large`, `embed_failed`, `conversation_token_cap`). Test
    asserts the set of codes covered matches a known list, so a new code
    forces an update.

## Risks / open items

- **Pending-to-server transition flash.** If realtime is unusually slow,
  the optimistic chip could linger after the row is created and before
  the `INSERT` event arrives. Mitigated by also merging the 201 response
  body into local state (idempotent against the eventual `INSERT`).
- **`PendingUpload`s leak on tab close mid-upload.** They live only in
  React state, so this is purely cosmetic on the abandoned tab; no server
  side effect. Not a regression — it already happens with the current
  `setError` flow.
- **Drag-and-drop drop-zone polish** isn't included. The drop target is
  the form (existing); we don't add a highlight on `dragover`. Reasonable
  follow-up if drop discoverability comes up in usage.
- **Per-byte progress** isn't shown. For 25 MB on a 1 Mb/s link a user
  waits 200 s with only a spinner. If this matters, an `XMLHttpRequest`
  port with `progress` events is a future iteration; sticking with `fetch`
  for now keeps the diff small.
