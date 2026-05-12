# Manage Attached Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user detach a previously-attached document from a conversation, with hard-delete semantics and a confirmation dialog. Chunks cascade away so retrieval tools stop returning the document's content immediately, and the chip rail updates in realtime across tabs.

**Architecture:** Add `DELETE /api/threads/:id/documents/:documentId` (owner-checked, deletes storage blob then DB row; cascade drops chunks). Extend the `useThreadDocuments` hook with a third realtime subscription (`event: 'DELETE'`) and a `detach()` callback that optimistically removes the chip and rolls back on non-2xx (excluding 404). Add a per-chip `X` button gated by a ShadCN `AlertDialog`. Spec: `docs/superpowers/specs/2026-05-12-manage-attached-documents-design.md`.

**Tech Stack:** Next.js App Router (Route Handlers), Kysely (`adminDb`), Supabase JS (storage + realtime), React 19 with hooks, ShadCN `alert-dialog`, lucide icons, Vitest + Testing Library + happy-dom, Biome.

---

## File Structure

**New files:**
- `src/app/api/threads/[id]/documents/_shared.ts` — `ensureOwned(threadId, userId)` helper hoisted from the existing route. Underscore-prefixed → not a routable folder under App Router.
- `src/app/api/threads/[id]/documents/[documentId]/route.ts` — `DELETE` handler.
- `src/app/api/threads/[id]/documents/[documentId]/route.test.ts` — Vitest unit tests for the handler.
- `src/app/(authed)/chat/document-chip-rail.test.tsx` — Vitest + Testing Library tests for the chip rail's detach UX.

**Modified files:**
- `src/app/api/threads/[id]/documents/route.ts` — import `ensureOwned` from `_shared.ts` instead of defining locally.
- `src/app/(authed)/chat/use-thread-documents.ts` — add DELETE subscription and `detach` callback.
- `src/app/(authed)/chat/document-chip-rail.tsx` — accept `onDetach`, add X button + AlertDialog, track per-chip pending state.
- `src/app/(authed)/chat/chat-view.tsx` — destructure `detach` from the hook and pass it to the rail.

**Responsibility boundaries:** server side (route + shared helper) is independent of client side (hook + rail + chat-view). Tasks 1–2 ship the server changes; Tasks 3–5 ship the client changes; they meet at the DELETE URL.

---

### Task 1: Hoist `ensureOwned` to a shared helper

**Goal:** Move the thread-ownership check used by GET/POST into a colocated `_shared.ts` so the new DELETE handler can reuse the exact same implementation.

**Files:**
- Create: `src/app/api/threads/[id]/documents/_shared.ts`
- Modify: `src/app/api/threads/[id]/documents/route.ts` (lines 1–10, 34–42)

**Acceptance Criteria:**
- [ ] `_shared.ts` exports an async `ensureOwned(threadId: string, userId: string): Promise<boolean>` that mirrors the current behavior.
- [ ] The existing `route.ts` imports `ensureOwned` from `./_shared` and no longer defines the helper locally.
- [ ] `pnpm typecheck` and `pnpm lint` pass.
- [ ] `pnpm test src/app/api/threads/[id]/documents/route.test.ts` still passes (no behavioral change).

**Verify:** `pnpm typecheck && pnpm lint && pnpm test src/app/api/threads/[id]/documents/route.test.ts` → all green.

**Steps:**

- [ ] **Step 1: Create the shared helper.**

```ts
// src/app/api/threads/[id]/documents/_shared.ts
import 'server-only';

import { adminDb } from '@/lib/db/admin';

export async function ensureOwned(threadId: string, userId: string): Promise<boolean> {
  const t = await adminDb
    .selectFrom('threads')
    .select(['id'])
    .where('id', '=', threadId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return !!t;
}
```

- [ ] **Step 2: Update the existing route to import the helper.**

In `src/app/api/threads/[id]/documents/route.ts`, delete the local `async function ensureOwned(...)` definition (lines ~34–42) and add this import beside the others near the top of the file:

```ts
import { ensureOwned } from './_shared';
```

No other changes — call sites already match the helper's signature.

- [ ] **Step 3: Verify.**

```bash
pnpm typecheck
pnpm lint
pnpm test src/app/api/threads/[id]/documents/route.test.ts
```

Expected: all pass. Existing route tests exercise the helper indirectly (auth flow tests).

- [ ] **Step 4: Commit.**

```bash
git add src/app/api/threads/[id]/documents/_shared.ts src/app/api/threads/[id]/documents/route.ts
git commit -m "refactor: hoist ensureOwned for thread document routes"
```

---

### Task 2: `DELETE /api/threads/[id]/documents/[documentId]` handler

**Goal:** Implement the DELETE route — owner-checked, deletes the storage blob (best-effort) and the `documents` row (cascade drops chunks).

**Files:**
- Create: `src/app/api/threads/[id]/documents/[documentId]/route.ts`
- Create: `src/app/api/threads/[id]/documents/[documentId]/route.test.ts`

**Acceptance Criteria:**
- [ ] 401 when unauthenticated.
- [ ] 404 when the thread is not owned by the caller.
- [ ] 404 when the document does not exist or its `thread_id` does not match the URL's thread id.
- [ ] On success: `deleteDocumentBlob(storage_path)` is invoked, then `adminDb.deleteFrom('documents')` is invoked, then `204 No Content` is returned.
- [ ] When `deleteDocumentBlob` throws, the DB delete still runs and the response is still `204`. The thrown error is logged via `console.warn`.
- [ ] Tests cover: 401, 404 (not-owned), 404 (doc not in thread), happy path, storage-failure path.

**Verify:** `pnpm test src/app/api/threads/[id]/documents/[documentId]/route.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Write the test file first.**

Create `src/app/api/threads/[id]/documents/[documentId]/route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUser, del, dbMock } = vi.hoisted(() => ({
  getUser: vi.fn(),
  del: vi.fn().mockResolvedValue(undefined),
  dbMock: {
    selectFrom: vi.fn(),
    deleteFrom: vi.fn(),
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock('@/lib/storage/documents', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/storage/documents')>('@/lib/storage/documents');
  return { ...actual, deleteDocumentBlob: del };
});

vi.mock('@/lib/db/admin', () => ({ adminDb: dbMock }));

import { DELETE } from './route';

function ctx() {
  return { params: Promise.resolve({ id: 't', documentId: 'd' }) };
}
function req() {
  return new Request('http://test/api/threads/t/documents/d', { method: 'DELETE' });
}

// Builder mocks --------------------------------------------------------------
// ensureOwned (threads): selectFrom('threads').select(['id']).where(...).where(...).executeTakeFirst()
function ownedTrue() {
  return {
    select: () => ({
      where: () => ({ where: () => ({ executeTakeFirst: async () => ({ id: 't' }) }) }),
    }),
  };
}
function ownedFalse() {
  return {
    select: () => ({
      where: () => ({ where: () => ({ executeTakeFirst: async () => undefined }) }),
    }),
  };
}
// document lookup: selectFrom('documents').select([...]).where('id',=,d).where('thread_id',=,t).executeTakeFirst()
function docFound(storagePath = 'u/t/d.pdf') {
  return {
    select: () => ({
      where: () => ({
        where: () => ({ executeTakeFirst: async () => ({ id: 'd', storage_path: storagePath }) }),
      }),
    }),
  };
}
function docMissing() {
  return {
    select: () => ({
      where: () => ({ where: () => ({ executeTakeFirst: async () => undefined }) }),
    }),
  };
}

function deleteBuilder(executeSpy: ReturnType<typeof vi.fn>) {
  return { where: () => ({ execute: executeSpy }) };
}

beforeEach(() => {
  getUser.mockResolvedValue({ data: { user: { id: 'u' } } });
});
afterEach(() => vi.clearAllMocks());

describe('DELETE /api/threads/[id]/documents/[documentId]', () => {
  it('401 when unauthenticated', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(401);
  });

  it('404 when thread is not owned', async () => {
    dbMock.selectFrom.mockReturnValueOnce(ownedFalse());
    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(404);
  });

  it('404 when document is not in thread', async () => {
    dbMock.selectFrom
      .mockReturnValueOnce(ownedTrue())     // ensureOwned
      .mockReturnValueOnce(docMissing());   // document lookup
    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(404);
  });

  it('204 on happy path; deletes blob then row', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    dbMock.selectFrom
      .mockReturnValueOnce(ownedTrue())
      .mockReturnValueOnce(docFound('u/t/d.pdf'));
    dbMock.deleteFrom.mockReturnValueOnce(deleteBuilder(execute));

    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalledWith('u/t/d.pdf');
    expect(execute).toHaveBeenCalledTimes(1);
    // Blob delete is attempted before the row delete.
    expect(del.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
  });

  it('still 204 when blob delete fails; row delete still runs', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    dbMock.selectFrom
      .mockReturnValueOnce(ownedTrue())
      .mockReturnValueOnce(docFound('u/t/d.pdf'));
    dbMock.deleteFrom.mockReturnValueOnce(deleteBuilder(execute));
    del.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(204);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail.**

```bash
pnpm test src/app/api/threads/[id]/documents/[documentId]/route.test.ts
```

Expected: FAIL — module `./route` does not exist yet.

- [ ] **Step 3: Implement the route handler.**

Create `src/app/api/threads/[id]/documents/[documentId]/route.ts`:

```ts
import 'server-only';

import { adminDb } from '@/lib/db/admin';
import { deleteDocumentBlob } from '@/lib/storage/documents';
import { createClient } from '@/lib/supabase/server';
import { ensureOwned } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; documentId: string }> },
) {
  const { id: threadId, documentId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return err(401, 'unauthorized');
  if (!(await ensureOwned(threadId, user.id))) return err(404, 'not_found');

  const doc = await adminDb
    .selectFrom('documents')
    .select(['id', 'storage_path'])
    .where('id', '=', documentId)
    .where('thread_id', '=', threadId)
    .executeTakeFirst();
  if (!doc) return err(404, 'not_found');

  // Best-effort blob delete. An orphaned blob is recoverable by a future janitor;
  // an orphaned DB row would leave the chip rail in a broken state. Prefer DB
  // consistency over storage consistency.
  try {
    await deleteDocumentBlob(doc.storage_path);
  } catch (e) {
    console.warn(
      `[documents] storage delete failed for ${doc.storage_path}:`,
      e instanceof Error ? e.message : e,
    );
  }

  await adminDb.deleteFrom('documents').where('id', '=', documentId).execute();

  return new Response(null, { status: 204 });
}
```

- [ ] **Step 4: Run tests to verify pass.**

```bash
pnpm test src/app/api/threads/[id]/documents/[documentId]/route.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Lint + typecheck.**

```bash
pnpm typecheck
pnpm lint
```

Expected: both pass.

- [ ] **Step 6: Commit.**

```bash
git add src/app/api/threads/[id]/documents/[documentId]/route.ts src/app/api/threads/[id]/documents/[documentId]/route.test.ts
git commit -m "feat: DELETE route for detaching a document from a conversation"
```

---

### Task 3: `useThreadDocuments` — DELETE realtime + `detach` callback

**Goal:** Extend the hook so it tears down rows on realtime DELETE events and exposes a `detach` callback that performs an optimistic, rollback-safe DELETE.

**Files:**
- Modify: `src/app/(authed)/chat/use-thread-documents.ts`

**Acceptance Criteria:**
- [ ] `useThreadDocuments` returns `{ documents, refresh, detach }`.
- [ ] `detach(documentId)`:
  - Optimistically removes the matching chip from local state.
  - Issues `DELETE /api/threads/:threadId/documents/:documentId`.
  - On 2xx OR 404: no-op (chip stays removed).
  - On any other non-2xx, OR on network error: restores the chip in its prior position and rethrows the error so the rail can surface it.
  - Is a no-op (and resolves) when called with no active `threadId`.
- [ ] A third `.on('postgres_changes', { event: 'DELETE', … })` subscription is added to the channel. Its handler removes the matching row by `payload.old.id`.
- [ ] `pnpm typecheck` and `pnpm lint` pass.

**Verify:** `pnpm typecheck && pnpm lint` → green. Hook behavior is tested end-to-end in Task 4 (via the rail) and exercised manually in Task 5.

**Steps:**

- [ ] **Step 1: Modify the hook.**

Replace the body of `src/app/(authed)/chat/use-thread-documents.ts` with the version below. The only changes from the current file are: (a) a `detach` callback, (b) a DELETE realtime subscription chained before `.subscribe()`, (c) returning `detach`.

```ts
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

  // `overrideThreadId` lets callers refresh against a freshly-created thread id
  // without waiting for the state-bound `threadId` to propagate through the next
  // render — avoids a stale-closure race in flows that create-then-upload.
  const refresh = useCallback(
    async (overrideThreadId?: string) => {
      const id = overrideThreadId ?? threadId;
      if (!id) return;
      const res = await fetch(`/api/threads/${id}/documents`);
      if (!res.ok) return;
      const body = (await res.json()) as { documents: ThreadDocument[] };
      setDocuments(body.documents);
    },
    [threadId],
  );

  const detach = useCallback(
    async (documentId: string) => {
      if (!threadId) return;
      let snapshot: { row: ThreadDocument; index: number } | null = null;
      setDocuments((prev) => {
        const index = prev.findIndex((d) => d.id === documentId);
        if (index === -1) return prev;
        const row = prev[index];
        if (!row) return prev;
        snapshot = { row, index };
        return prev.filter((d) => d.id !== documentId);
      });
      try {
        const res = await fetch(`/api/threads/${threadId}/documents/${documentId}`, {
          method: 'DELETE',
        });
        // 404 = already gone (another tab won the race). Treat as success.
        if (!res.ok && res.status !== 404) {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        // Roll back the optimistic removal. Re-insert at the original index so
        // chip order matches the server's `created_at asc` ordering.
        if (snapshot) {
          const restore = snapshot;
          setDocuments((prev) => {
            if (prev.some((d) => d.id === restore.row.id)) return prev;
            const next = prev.slice();
            next.splice(Math.min(restore.index, next.length), 0, restore.row);
            return next;
          });
        }
        throw err;
      }
    },
    [threadId],
  );

  // Reset when the thread (and therefore the initial list) changes.
  useEffect(() => {
    setDocuments(initial);
  }, [initial]);

  // Realtime: INSERT/UPDATE/DELETE on documents filtered by thread.
  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;

    // Wait for the user session, then prime realtime with the access token so
    // postgres_changes evaluates RLS as the authenticated user (not anon — which
    // can't see `documents` rows under our `documents_select_own` policy).
    void (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      if (session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }
      channel = supabase
        .channel(`thread-documents:${threadId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'documents',
            filter: `thread_id=eq.${threadId}`,
          },
          (payload) => {
            const row = payload.new as ThreadDocument;
            setDocuments((prev) => (prev.some((d) => d.id === row.id) ? prev : [...prev, row]));
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'documents',
            filter: `thread_id=eq.${threadId}`,
          },
          (payload) => {
            // payload.new may be a partial row when the table's replica identity
            // is DEFAULT (only the PK + changed columns come through). The
            // documents migration sets REPLICA IDENTITY FULL, but merge defensively
            // so we don't blank out `name`/`kind`/`byte_size` if drift ever occurs.
            const partial = payload.new as Partial<ThreadDocument> & { id: string };
            setDocuments((prev) =>
              prev.map((d) => (d.id === partial.id ? { ...d, ...partial } : d)),
            );
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'DELETE',
            schema: 'public',
            table: 'documents',
            filter: `thread_id=eq.${threadId}`,
          },
          (payload) => {
            // `documents` has REPLICA IDENTITY FULL, so payload.old carries the
            // full pre-delete row.
            const old = payload.old as { id?: string };
            if (!old?.id) return;
            setDocuments((prev) => prev.filter((d) => d.id !== old.id));
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [threadId]);

  return { documents, refresh, detach };
}
```

- [ ] **Step 2: Verify typecheck + lint.**

```bash
pnpm typecheck
pnpm lint
```

Expected: both pass.

- [ ] **Step 3: Commit.**

```bash
git add src/app/(authed)/chat/use-thread-documents.ts
git commit -m "feat: realtime DELETE + detach callback in useThreadDocuments"
```

---

### Task 4: `DocumentChipRail` — X button, confirmation dialog, pending state

**Goal:** Add a per-chip detach control. Clicking `X` opens a confirmation dialog; confirming invokes `onDetach(id)`. While the request is in flight, the X is replaced by a spinner so double-clicks don't fire a second request.

**Files:**
- Modify: `src/app/(authed)/chat/document-chip-rail.tsx`
- Create: `src/app/(authed)/chat/document-chip-rail.test.tsx`

**Acceptance Criteria:**
- [ ] `DocumentChipRail` accepts a new prop `onDetach: (id: string) => Promise<void> | void`.
- [ ] Each chip renders an `X` button. The X is hidden by default and revealed on chip hover via `group-hover`; it's always visible on `failed` chips.
- [ ] Clicking the X opens an `AlertDialog` with title "Detach document", body referencing the document name, Cancel (default), and Detach (destructive variant).
- [ ] Cancel closes the dialog without invoking `onDetach`.
- [ ] Confirming closes the dialog, marks the chip pending, and awaits `onDetach(id)`. While pending, the X button is replaced by a `Loader2` spinner (and is disabled so it can't be re-clicked).
- [ ] On `onDetach` reject, the chip remains visible (because the hook restores it) and the spinner is removed. An error message is surfaced to the user (toast or inline — see Step 4).
- [ ] Tests cover: X is rendered, dialog opens, Cancel does not call `onDetach`, Confirm calls `onDetach(id)`, spinner is shown during the in-flight callback.

**Verify:** `pnpm test src/app/(authed)/chat/document-chip-rail.test.tsx` → all pass.

**Steps:**

- [ ] **Step 1: Write the test file.**

Create `src/app/(authed)/chat/document-chip-rail.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DocumentChipRail } from './document-chip-rail';
import type { ThreadDocument } from './use-thread-documents';

function doc(overrides: Partial<ThreadDocument> = {}): ThreadDocument {
  return {
    id: 'd1',
    name: 'spec.pdf',
    kind: 'pdf',
    byte_size: 12345,
    status: 'ready',
    error_code: null,
    error_message: null,
    created_at: '2026-05-12T00:00:00Z',
    ready_at: '2026-05-12T00:00:01Z',
    ...overrides,
  };
}

describe('DocumentChipRail detach UX', () => {
  it('renders a detach button per chip', () => {
    render(<DocumentChipRail documents={[doc()]} onDetach={vi.fn()} />);
    expect(screen.getByRole('button', { name: /detach spec\.pdf/i })).toBeInTheDocument();
  });

  it('opens a confirmation dialog when X is clicked', async () => {
    const user = userEvent.setup();
    render(<DocumentChipRail documents={[doc()]} onDetach={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/detach document/i)).toBeInTheDocument();
    expect(screen.getByText(/spec\.pdf/i)).toBeInTheDocument();
  });

  it('does not call onDetach when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onDetach = vi.fn();
    render(<DocumentChipRail documents={[doc()]} onDetach={onDetach} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onDetach).not.toHaveBeenCalled();
  });

  it('calls onDetach(id) when Detach is confirmed', async () => {
    const user = userEvent.setup();
    const onDetach = vi.fn().mockResolvedValue(undefined);
    render(<DocumentChipRail documents={[doc({ id: 'abc' })]} onDetach={onDetach} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    // The confirm action button: scoped to the dialog so it can't collide with
    // the chip's X button.
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^detach$/i }));
    expect(onDetach).toHaveBeenCalledWith('abc');
  });

  it('shows a spinner while onDetach is in-flight', async () => {
    const user = userEvent.setup();
    let resolve: (() => void) | null = null;
    const onDetach = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    render(<DocumentChipRail documents={[doc()]} onDetach={onDetach} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^detach$/i }));
    expect(screen.getByTestId('chip-pending-d1')).toBeInTheDocument();
    resolve?.();
    await waitFor(() =>
      expect(screen.queryByTestId('chip-pending-d1')).not.toBeInTheDocument(),
    );
  });
});

```

- [ ] **Step 2: Run tests to verify they fail.**

```bash
pnpm test src/app/(authed)/chat/document-chip-rail.test.tsx
```

Expected: FAIL — `onDetach` prop does not exist, no `X` button rendered.

- [ ] **Step 3: Implement the chip rail.**

Replace the body of `src/app/(authed)/chat/document-chip-rail.tsx`:

```tsx
'use client';

import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { ThreadDocument } from './use-thread-documents';

interface Props {
  documents: ThreadDocument[];
  onDetach: (id: string) => Promise<void> | void;
}

export function DocumentChipRail({ documents, onDetach }: Props) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingDetachId, setPendingDetachId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const target = documents.find((d) => d.id === pendingId) ?? null;

  if (documents.length === 0) return null;

  const onConfirm = async () => {
    if (!target) return;
    const id = target.id;
    setPendingId(null);
    setPendingDetachId(id);
    setErrorMessage(null);
    try {
      await onDetach(id);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Detach failed');
    } finally {
      setPendingDetachId((curr) => (curr === id ? null : curr));
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {documents.map((d) => {
          const inFlight = pendingDetachId === d.id;
          const failed = d.status === 'failed';
          return (
            <span
              key={d.id}
              className="group inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-1 text-xs"
              title={
                failed
                  ? (d.error_message ?? d.error_code ?? 'Failed')
                  : `${d.kind.toUpperCase()} · ${formatBytes(d.byte_size)}`
              }
            >
              {d.status === 'processing' && <Loader2 className="size-3 animate-spin" />}
              {d.status === 'ready' && <CheckCircle2 className="size-3 text-emerald-600" />}
              {failed && <AlertCircle className="size-3 text-destructive" />}
              <span className="max-w-[16ch] truncate">{d.name}</span>
              {inFlight ? (
                <Loader2
                  data-testid={`chip-pending-${d.id}`}
                  className="size-3 animate-spin text-muted-foreground"
                />
              ) : (
                <button
                  type="button"
                  aria-label={`Detach ${d.name}`}
                  onClick={() => setPendingId(d.id)}
                  className={`rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100 ${
                    failed ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          );
        })}
      </div>
      {errorMessage && (
        <p className="text-xs text-destructive">Detach failed: {errorMessage}</p>
      )}
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setPendingId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Detach document</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{target?.name}&rdquo; will be removed from this conversation. The assistant
              won't be able to retrieve from it after this. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void onConfirm();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Detach
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 4: Run tests to verify pass.**

```bash
pnpm test src/app/(authed)/chat/document-chip-rail.test.tsx
```

Expected: 5 passing.

- [ ] **Step 5: Typecheck + lint.**

```bash
pnpm typecheck
pnpm lint
```

Expected: both pass. Note: at this point `chat-view.tsx` still calls `<DocumentChipRail documents={documents} />` without `onDetach` — TypeScript will fail with "Property 'onDetach' is missing". That gets fixed in Task 5; if you want a green checkpoint here, run only the focused test, then proceed straight to Task 5.

> If the typecheck error blocks your flow, you can squash Tasks 4 and 5 into a single commit. The split exists to keep concerns separable; correctness only requires both to land together.

- [ ] **Step 6: Commit.**

```bash
git add src/app/(authed)/chat/document-chip-rail.tsx src/app/(authed)/chat/document-chip-rail.test.tsx
git commit -m "feat: chip rail detach button and confirmation dialog"
```

---

### Task 5: Wire `detach` into `chat-view.tsx`

**Goal:** Pull the new `detach` callback out of `useThreadDocuments` and pass it to `DocumentChipRail`. Run the full verification suite.

**Files:**
- Modify: `src/app/(authed)/chat/chat-view.tsx` (lines 71, 463)

**Acceptance Criteria:**
- [ ] `useThreadDocuments` destructure includes `detach`.
- [ ] `<DocumentChipRail documents={documents} onDetach={detach} />`.
- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm test` are all green.

**Verify:** `pnpm typecheck && pnpm lint && pnpm test` → all green.

**Steps:**

- [ ] **Step 1: Update the destructure.**

In `src/app/(authed)/chat/chat-view.tsx`, line 71, change:

```tsx
  const { documents, refresh: refreshDocuments } = useThreadDocuments(threadId, initialDocuments);
```

to:

```tsx
  const { documents, refresh: refreshDocuments, detach: detachDocument } = useThreadDocuments(
    threadId,
    initialDocuments,
  );
```

- [ ] **Step 2: Pass `onDetach` to the rail.**

In `src/app/(authed)/chat/chat-view.tsx`, line ~463, change:

```tsx
        <DocumentChipRail documents={documents} />
```

to:

```tsx
        <DocumentChipRail documents={documents} onDetach={detachDocument} />
```

- [ ] **Step 3: Run the full test suite.**

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected: all pass.

- [ ] **Step 4: Manual verification checklist.**

Bring up the app:

```bash
pnpm db:start    # if not already running
pnpm dev
```

Walk through the spec's verification list (the subset that requires a running app):

1. Sign in as user A. Open `/chat`. Upload a small PDF or TXT. Wait until the chip flips to `ready`.
2. Hover the chip → the X appears. Click it → AlertDialog opens with the document name. Click Cancel → dialog closes, chip remains.
3. Click X again → confirm Detach. Chip disappears within ~100ms (optimistic). Open another browser tab on the same thread; confirm the chip is gone there too without refresh.
4. Re-upload the same document. While it's still `processing`, click X → Detach. The chip disappears immediately. In the Inngest dashboard, the run will eventually surface a step error (FK violation on chunk insert) and complete; no chunks remain.
5. Ask the assistant a question whose answer would require the detached document. Inspect the assistant's tool calls via the parts UI; `search_corpus` should return no results from that document.
6. Owner-only smoke: sign out, sign in as user B. `curl -X DELETE -i <user-A-thread-doc-URL>` (with B's session cookie) → 404.

- [ ] **Step 5: Commit.**

```bash
git add src/app/(authed)/chat/chat-view.tsx
git commit -m "feat: wire detach callback into chat view chip rail"
```

---

## Self-Review

**Spec coverage:**
- Hard delete → Tasks 1+2 (route invokes `adminDb.deleteFrom('documents')`, cascade defined in existing migration).
- Confirmation dialog → Task 4 (`AlertDialog`).
- Listing attached documents — already implemented in the parent story (#4); spec acknowledges this.
- Realtime DELETE across tabs → Task 3 (third `.on('postgres_changes', { event: 'DELETE', … })`).
- Owner-only, 404 on cross-thread / cross-user → Task 2 (`ensureOwned` + document lookup with thread_id filter).
- Best-effort blob delete, DB delete still runs → Task 2 (try/catch on `deleteDocumentBlob`).
- Detach during processing supported → Task 3+4 expose X on any status; Task 2 has no status filter on the doc lookup.
- Idempotent across tabs (404 = success) → Task 3 `detach` treats 404 as success.
- Optimistic UI + rollback → Task 3.
- Verification list mapped: items 1–4 covered by Task 2 tests; 5–6 by manual walk in Task 5; 7 by Task 4 tests; 8 by hook rollback logic in Task 3; 9 by manual walk in Task 5; 10 by manual walk in Task 5.

**Placeholder scan:** No "TBD"/"add appropriate" patterns. Every code step is complete.

**Type consistency:**
- `ThreadDocument` is unchanged across hook and rail.
- `onDetach` signature `(id: string) => Promise<void> | void` matches the hook's `detach: (documentId: string) => Promise<void>`.
- DELETE route `params` shape `{ id: string; documentId: string }` matches the directory layout.
- `deleteDocumentBlob(path: string)` matches `src/lib/storage/documents.ts`.

No gaps. Ready to execute.
