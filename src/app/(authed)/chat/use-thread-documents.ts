'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { detectKind, MAX_BYTES } from '@/lib/documents/upload-limits';
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

export interface PendingUpload {
  clientId: string;
  name: string;
  byte_size: number;
  created_at: string;
}

export interface RejectedUpload {
  clientId: string;
  name: string;
  byte_size: number;
  error_code: string;
  error_message: string | null;
  created_at: string;
}

export type ChipDocument =
  | ({ source: 'server'; clientId?: undefined } & ThreadDocument)
  | {
      source: 'pending';
      clientId: string;
      id: string;
      name: string;
      byte_size: number;
      status: 'pending';
      created_at: string;
    }
  | {
      source: 'rejected';
      clientId: string;
      id: string;
      name: string;
      byte_size: number;
      status: 'failed';
      error_code: string;
      error_message: string | null;
      created_at: string;
    };

export function useThreadDocuments(threadId: string | null, initial: ThreadDocument[]) {
  const [documents, setDocuments] = useState<ThreadDocument[]>(initial);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [rejected, setRejected] = useState<RejectedUpload[]>([]);
  // Shared in-flight thread-create promise, set externally by chat-view via
  // the returned `ensureThread` callback. Lets a thread be created exactly
  // once across concurrent uploads.
  const threadCreatePromiseRef = useRef<Promise<string> | null>(null);
  // Set by upload() right before awaiting ensureThread(). Tells the
  // reset-on-initial-change effect that the imminent `initialDocuments`
  // prop swap is one we triggered ourselves — keep pending/rejected
  // chips from the same upload batch alive across it.
  const selfCreatedThreadRef = useRef(false);

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
      let snapshot: { row: ThreadDocument; index: number } | undefined;
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
        if (!res.ok && res.status !== 404) {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        const restore = snapshot;
        if (restore) {
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

  // Uploads run in parallel and own all of their UX state via this hook —
  // pending chip → POST → either drop the pending entry (server row arrives
  // through realtime / direct insert) or convert it to a rejected entry.
  const upload = useCallback(
    async (files: FileList | File[], options?: { ensureThread?: () => Promise<string> }) => {
      const list = Array.from(files);
      if (list.length === 0) return;

      // Pre-check every file first. Rejected entries get their chip
      // immediately and never participate in the rest of the flow — and
      // critically, a batch where everything fails pre-check must NOT
      // trigger ensureThread (no point creating a thread just to drop
      // every file into a rejected chip).
      const passers: Array<{ file: File; clientId: string; createdAt: string }> = [];
      for (const file of list) {
        const clientId = cryptoRandomId();
        const createdAt = new Date().toISOString();
        if (file.size > MAX_BYTES) {
          setRejected((prev) => [
            ...prev,
            {
              clientId,
              name: file.name,
              byte_size: file.size,
              error_code: 'too_large',
              error_message: null,
              created_at: createdAt,
            },
          ]);
          continue;
        }
        if (!detectKind(file)) {
          setRejected((prev) => [
            ...prev,
            {
              clientId,
              name: file.name,
              byte_size: file.size,
              error_code: 'unsupported_type',
              error_message: null,
              created_at: createdAt,
            },
          ]);
          continue;
        }
        passers.push({ file, clientId, createdAt });
      }
      if (passers.length === 0) return;

      let targetThreadId = threadId;
      if (!targetThreadId) {
        const ensure = options?.ensureThread;
        if (!ensure) return;
        if (!threadCreatePromiseRef.current) {
          threadCreatePromiseRef.current = ensure();
        }
        // Tell the reset-on-initial-change effect that the next prop
        // swap was caused by us; do not wipe pending/rejected chips
        // that belong to the same upload batch.
        selfCreatedThreadRef.current = true;
        try {
          targetThreadId = await threadCreatePromiseRef.current;
        } catch (err) {
          threadCreatePromiseRef.current = null;
          const ts = new Date().toISOString();
          setRejected((prev) => [
            ...prev,
            ...passers.map((p) => ({
              clientId: p.clientId,
              name: p.file.name,
              byte_size: p.file.size,
              error_code: 'thread_create_failed',
              error_message: err instanceof Error ? err.message : null,
              created_at: ts,
            })),
          ]);
          return;
        }
        threadCreatePromiseRef.current = null;
      }
      const usedThreadId = targetThreadId;

      await Promise.all(
        passers.map(async ({ file, clientId, createdAt }) => {
          setPending((prev) => [
            ...prev,
            { clientId, name: file.name, byte_size: file.size, created_at: createdAt },
          ]);

          const fd = new FormData();
          fd.set('file', file);
          try {
            const res = await fetch(`/api/threads/${usedThreadId}/documents`, {
              method: 'POST',
              body: fd,
            });
            if (!res.ok) {
              const body = (await res.json().catch(() => null)) as {
                error?: string;
                message?: string;
              } | null;
              setPending((prev) => prev.filter((p) => p.clientId !== clientId));
              setRejected((prev) => [
                ...prev,
                {
                  clientId,
                  name: file.name,
                  byte_size: file.size,
                  error_code: body?.error ?? 'upload_failed',
                  error_message: body?.message ?? null,
                  created_at: createdAt,
                },
              ]);
              return;
            }
            // 201: merge the server row into local state immediately so the
            // chip transitions seamlessly even if realtime is slow. The
            // eventual INSERT event is idempotent against an existing id.
            const body = (await res.json().catch(() => null)) as {
              document?: ThreadDocument;
            } | null;
            const serverDoc = body?.document;
            if (serverDoc) {
              setDocuments((prev) =>
                prev.some((d) => d.id === serverDoc.id)
                  ? prev
                  : [
                      ...prev,
                      {
                        ...serverDoc,
                        error_code: serverDoc.error_code ?? null,
                        error_message: serverDoc.error_message ?? null,
                        ready_at: serverDoc.ready_at ?? null,
                      },
                    ],
              );
            }
            setPending((prev) => prev.filter((p) => p.clientId !== clientId));
          } catch (err) {
            setPending((prev) => prev.filter((p) => p.clientId !== clientId));
            setRejected((prev) => [
              ...prev,
              {
                clientId,
                name: file.name,
                byte_size: file.size,
                error_code: 'upload_failed',
                error_message: err instanceof Error ? err.message : null,
                created_at: createdAt,
              },
            ]);
          }
        }),
      );
      void refresh(usedThreadId);
    },
    [refresh, threadId],
  );

  // One handler for both server-row detach and client-only rejected dismiss.
  // The chip rail doesn't need to know which backing store an entry comes
  // from — it just passes the chip's id back.
  const dismiss = useCallback(
    async (id: string) => {
      const isRejected = rejected.some((r) => r.clientId === id);
      if (isRejected) {
        setRejected((prev) => prev.filter((r) => r.clientId !== id));
        return;
      }
      await detach(id);
    },
    [detach, rejected],
  );

  const chips: ChipDocument[] = mergeChips(documents, pending, rejected);

  useEffect(() => {
    setDocuments(initial);
    if (!selfCreatedThreadRef.current) {
      setPending([]);
      setRejected([]);
    }
    selfCreatedThreadRef.current = false;
  }, [initial]);

  // Realtime: INSERT/UPDATE/DELETE on documents filtered by thread.
  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;

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

  return { documents: chips, refresh, upload, dismiss };
}

function mergeChips(
  documents: ThreadDocument[],
  pending: PendingUpload[],
  rejected: RejectedUpload[],
): ChipDocument[] {
  const merged: ChipDocument[] = [
    ...documents.map(
      (d) =>
        ({
          source: 'server',
          ...d,
        }) satisfies ChipDocument,
    ),
    ...pending.map(
      (p) =>
        ({
          source: 'pending',
          clientId: p.clientId,
          id: p.clientId,
          name: p.name,
          byte_size: p.byte_size,
          status: 'pending' as const,
          created_at: p.created_at,
        }) satisfies ChipDocument,
    ),
    ...rejected.map(
      (r) =>
        ({
          source: 'rejected',
          clientId: r.clientId,
          id: r.clientId,
          name: r.name,
          byte_size: r.byte_size,
          status: 'failed' as const,
          error_code: r.error_code,
          error_message: r.error_message,
          created_at: r.created_at,
        }) satisfies ChipDocument,
    ),
  ];
  // Defensive: every code path that produces a chip sets `created_at`,
  // but a partial realtime payload (REPLICA IDENTITY FULL not propagating
  // every column, or a future schema change) shouldn't crash the rail.
  merged.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  return merged;
}

function cryptoRandomId(): string {
  return `c-${crypto.randomUUID()}`;
}
