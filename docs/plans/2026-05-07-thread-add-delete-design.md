# Thread Add / Delete Design

**Status:** Validated, ready to plan implementation
**Date:** 2026-05-07
**Linear:** [MSH-7 — Provide add and delete buttons for chat threads](https://linear.app/mshick/issue/MSH-7/provide-add-and-delete-buttons-for-chat-threads)
**Related:** [src/app/(authed)/chat/chat-view.tsx](../../src/app/(authed)/chat/chat-view.tsx), [supabase/migrations/20260507124222_chat_schema.sql](../../supabase/migrations/20260507124222_chat_schema.sql), [CLAUDE.md](../../CLAUDE.md)

## Summary

Add two affordances to the chat sidebar: a **"+ New chat"** button at the top that routes to `/chat` (lazy-create, no DB write until first message), and a **trash icon per thread row** that opens a confirmation modal and deletes the thread (with messages cascading) via a REST endpoint. Codify "REST, not server actions" as a project convention in `CLAUDE.md`.

## Decisions

| Question | Choice |
|---|---|
| New chat semantics | **Lazy-create**: navigate to `/chat`, no DB row until first message |
| Delete confirmation | **ShadCN `AlertDialog`** modal (named thread + irreversibility warning) |
| Active-thread delete | Navigate to `/chat` empty state (don't auto-pick another) |
| Mutation transport | **REST endpoint** under `/api/...`, not a server action |
| Optimistic UI | None — `router.refresh()` after 204 |
| Existing login server actions | Out of scope for this PR; separate ticket to convert later |

## Architecture

### 1. ShadCN `AlertDialog` primitive

```bash
pnpm dlx shadcn@latest add alert-dialog
```

Generates `src/components/ui/alert-dialog.tsx`, pulls in `@radix-ui/react-alert-dialog`. No customization needed.

### 2. REST endpoint — `src/app/api/threads/[id]/route.ts`

```ts
import { createClient } from '@/lib/supabase/server';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });

  // RLS enforces ownership; unauthorized → zero rows affected, no error.
  const { error } = await supabase.from('threads').delete().eq('id', id);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return new Response(null, { status: 204 });
}
```

- **User-context Supabase server client** (not `adminDb`). RLS policy `threads_delete_own` does the ownership check; no need to compare user ids in app code.
- **204 on success**, **idempotent on missing/foreign rows** (RLS makes them invisible — zero rows affected, no error).
- **CASCADE** on `messages.thread_id` cleans up child messages.
- No request body, no extra fields.

### 3. `chat-view.tsx` modifications

#### "+ New chat" button

Top of the sidebar, full-width, `<Button variant="outline">`. On click:

```ts
const handleNewChat = () => {
  setInput('');
  setError(null);
  abortRef.current?.abort();
  router.push('/chat');
};
```

Manually resets local state — `router.push` alone won't remount the component when only `searchParams` change.

#### Trash icon per thread row

Refactor the row from `<Link>`-wrapping-everything to **link + sibling button**:

```tsx
<div data-active={t.id === threadId} className="group flex items-center gap-1">
  <Link
    href={`/chat?thread=${t.id}`}
    aria-current={t.id === threadId ? 'page' : undefined}
    className="flex-1 truncate rounded-md px-2 py-1.5 text-sm hover:bg-muted ..."
  >
    {t.title ?? 'Untitled'}
  </Link>
  <button
    type="button"
    onClick={() => setPendingDeleteId(t.id)}
    className="opacity-0 group-hover:opacity-100 group-data-[active=true]:opacity-100 ..."
    aria-label={`Delete thread ${t.title ?? 'Untitled'}`}
  >
    <Trash2 className="size-4" />
  </button>
</div>
```

The button is a **sibling** of `<Link>`, not nested — otherwise clicks would navigate before triggering the modal.

#### AlertDialog wiring

Component-level state:

```ts
const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
const [deleteError, setDeleteError] = useState<string | null>(null);
const [isDeleting, startDelete] = useTransition();

const pendingThread = threads.find((t) => t.id === pendingDeleteId);
```

Single `<AlertDialog>` at the bottom, opened by `pendingDeleteId !== null`. Title: "Delete thread?". Description: `"<title>" and all of its messages will be permanently deleted. This cannot be undone.` Cancel + destructive Delete; Delete is disabled while `isDeleting`. Inline error if the request fails — dialog stays open so user can retry.

On confirm:

```ts
startDelete(async () => {
  setDeleteError(null);
  const res = await fetch(`/api/threads/${pendingDeleteId}`, { method: 'DELETE' });
  if (!res.ok) {
    setDeleteError(await res.text().catch(() => `HTTP ${res.status}`));
    return;
  }
  const wasActive = pendingDeleteId === threadId;
  setPendingDeleteId(null);
  if (wasActive) router.replace('/chat');
  else router.refresh();
});
```

### 4. CLAUDE.md convention

Add to the `## Conventions` section:

> **Client → server interactions go through REST under `/api/...`** — never server actions. Use Route Handlers for mutations (`POST`/`PUT`/`PATCH`/`DELETE`) and call them with `fetch` + `useTransition`. Server actions are not used in this project.

## Edge cases

- **Concurrent delete from two tabs** — both DELETEs return 204 (the second hits zero rows; not an error). Idempotent.
- **Deleting the only thread** — `router.replace('/chat')` lands on empty state.
- **Deleting the active thread mid-stream** — navigation unmounts the chat view, the SSE reader closes, the AbortController aborts the in-flight `fetch`. The Inngest function continues to completion; its final UPDATE affects zero rows (CASCADE removed them) and silently succeeds. Realtime publishes go to a channel with no subscribers and are dropped.
- **"+ New chat" mid-stream** — same unmount + abort path.
- **Cross-user attack via DevTools** — `DELETE /api/threads/<other-id>` returns 204 but RLS makes the row invisible; zero rows affected. No information leak.

## Testing

The schema is unchanged, so the existing Kysely type smoke test stays valid. **No automated tests for this PR** — the route handler is ~12 lines, RLS is the security gate, and the project doesn't have e2e set up. Verification is manual:

1. Hover a thread → trash icon appears.
2. Active thread always shows trash.
3. Click trash on a non-active thread → AlertDialog opens with title.
4. Cancel → dialog closes, no DB change.
5. Confirm → dialog closes, sidebar refreshes, thread + messages gone.
6. Delete active thread → URL becomes `/chat`.
7. Click "+ New chat" while typing → URL becomes `/chat`, input cleared.
8. DevTools `fetch('/api/threads/<other-user-id>', {method:'DELETE'})` → 204 but DB shows the row intact.

## Out of scope (cuts)

- Bulk delete / multi-select
- Soft delete + undo toast (would require schema change)
- Rename thread (separate ticket)
- Reorder / pin / archive
- Conversion of `src/app/login/actions.ts` server actions to REST (separate ticket — convention applies forward)

## Implementation order

1. `pnpm dlx shadcn@latest add alert-dialog`. Verify primitive lands cleanly.
2. Add `src/app/api/threads/[id]/route.ts`. Verify with curl + auth cookie that 204 fires and rows go away.
3. Update `chat-view.tsx`: state, "+ New chat" button, sidebar row refactor (link + trash sibling), AlertDialog wiring.
4. Add the CLAUDE.md convention bullet.
5. Manual run-through of the 8-step verification list.
