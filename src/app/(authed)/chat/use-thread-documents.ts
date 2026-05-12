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
      // Typed explicitly as the non-null shape so TS doesn't narrow to `never`
      // after the assignment inside the setState callback.
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
          // `snapshot` is assigned inside a setState callback so TS can't narrow
          // the outer binding. Cast to the known non-null shape to satisfy strict.
          const restore = snapshot as { row: ThreadDocument; index: number };
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
