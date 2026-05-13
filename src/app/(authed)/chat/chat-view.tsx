'use client';

import { Paperclip, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react';
import { Streamdown } from 'streamdown';
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
import { Button } from '@/components/ui/button';
import { DocumentChipRail } from './document-chip-rail';
import { type ThreadDocument, useThreadDocuments } from './use-thread-documents';

// MessagePart mirrors the shape persisted by the Inngest chatStream function in
// `messages.parts`. Co-located here (not in a shared module) to keep the
// renderer the single owner and avoid import cycles with `page.tsx`.
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: unknown }
  | { type: 'tool-result'; toolName: string; toolCallId: string; result: unknown };

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  parts: MessagePart[] | null;
}

interface ThreadSummary {
  id: string;
  title: string | null;
  updated_at: string;
}

interface ChatViewProps {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  initialMessages: Message[];
  initialDocuments: ThreadDocument[];
}

type Status = 'idle' | 'streaming' | 'error';

export function ChatView({
  threads,
  activeThreadId,
  initialMessages,
  initialDocuments,
}: ChatViewProps) {
  const router = useRouter();
  const inputId = useId();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [threadId, setThreadId] = useState<string | null>(activeThreadId);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const {
    documents,
    upload: uploadDocuments,
    dismiss: dismissDocument,
  } = useThreadDocuments(threadId, initialDocuments);

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, startDelete] = useTransition();
  const pendingThread = threads.find((t) => t.id === pendingDeleteId) ?? null;

  const handleNewChat = useCallback(() => {
    setInput('');
    setError(null);
    abortRef.current?.abort();
    abortRef.current = null;
    router.push('/chat');
  }, [router]);

  const confirmDelete = useCallback(() => {
    if (!pendingDeleteId) return;
    const targetId = pendingDeleteId;
    startDelete(async () => {
      setDeleteError(null);
      try {
        const res = await fetch(`/api/threads/${targetId}`, { method: 'DELETE' });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          setDeleteError(body || `HTTP ${res.status}`);
          return;
        }
      } catch (err) {
        setDeleteError(err instanceof Error ? err.message : 'Network error');
        return;
      }
      const wasActive = targetId === threadId;
      setPendingDeleteId(null);
      if (wasActive) router.replace('/chat');
      else router.refresh();
    });
  }, [pendingDeleteId, router, threadId]);

  // Track the last-synced prop value so the effect only reacts to true prop
  // changes (sidebar click, back/forward, "New chat") and not to local state
  // updates that happen to land before the parent re-renders. send() bumps
  // this ref proactively when it knows the new thread id, so the ensuing
  // router.replace prop-change is treated as already-handled.
  const lastSyncedActiveThreadIdRef = useRef<string | null>(activeThreadId);
  useEffect(() => {
    if (activeThreadId === lastSyncedActiveThreadIdRef.current) return;
    lastSyncedActiveThreadIdRef.current = activeThreadId;
    abortRef.current?.abort();
    abortRef.current = null;
    setThreadId(activeThreadId);
    setMessages(initialMessages);
    setInput('');
    setError(null);
    setStatus('idle');
    setPendingDeleteId(null);
    setDeleteError(null);
  }, [activeThreadId, initialMessages]);

  // Abort any in-flight fetch when the component unmounts (sign-out, route
  // away from /chat, hot reload). The prop-sync effect above handles
  // same-route navigations.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const consumeStream = useCallback(async (res: Response, assistantId: string) => {
    if (!res.ok || !res.body) {
      const errBody = await res.text().catch(() => '');
      throw new Error(errBody || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx === -1) break;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSseFrame(frame);
        if (!event) continue;

        if (event.event === 'delta' && typeof event.data?.text === 'string') {
          const delta = event.data.text as string;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + delta } : m)),
          );
        } else if (event.event === 'error') {
          throw new Error((event.data?.message as string) ?? 'stream error');
        }
      }
    }
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || status === 'streaming') return;

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStatus('streaming');
    setError(null);
    setInput('');

    // Optimistic local user + placeholder assistant.
    const tempUserId = `local-user-${crypto.randomUUID()}`;
    const tempAssistantId = `local-assistant-${crypto.randomUUID()}`;
    setMessages((prev) => [
      ...prev,
      { id: tempUserId, role: 'user', text, parts: null },
      { id: tempAssistantId, role: 'assistant', text: '', parts: null },
    ]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: threadId, content: text }),
        signal: ctrl.signal,
      });

      const newThreadId = res.headers.get('X-Thread-Id');
      const realAssistantId = res.headers.get('X-Assistant-Message-Id');
      if (newThreadId && newThreadId !== threadId) {
        setThreadId(newThreadId);
        // Tell the prop-sync effect we're already aware of this thread id, so
        // when the parent's RSC re-render arrives with the new activeThreadId
        // prop, the effect treats it as already-synced and skips the reset
        // (which would otherwise abort the in-flight stream).
        lastSyncedActiveThreadIdRef.current = newThreadId;
        router.replace(`/chat?thread=${newThreadId}`);
      }
      if (realAssistantId) {
        setMessages((prev) =>
          prev.map((m) => (m.id === tempAssistantId ? { ...m, id: realAssistantId } : m)),
        );
      }

      await consumeStream(res, realAssistantId ?? tempAssistantId);
      setStatus('idle');
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        // Stop was clicked before headers arrived — drop the orphan assistant placeholder.
        setMessages((prev) =>
          prev.filter((m) => !(m.id === tempAssistantId && m.role === 'assistant')),
        );
        return;
      }
      const message = err instanceof Error ? err.message : 'Stream failed';
      setError(message);
      setStatus('error');
    } finally {
      abortRef.current = null;
    }
  }, [consumeStream, input, router, status, threadId]);

  const regenerate = useCallback(
    async (assistantMessageId: string) => {
      if (status === 'streaming') return;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setStatus('streaming');
      setError(null);

      // Replace the message we're regenerating with a fresh empty placeholder.
      const tempAssistantId = `local-assistant-${crypto.randomUUID()}`;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId ? { ...m, id: tempAssistantId, text: '', parts: null } : m,
        ),
      );

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ regenerate_message_id: assistantMessageId }),
          signal: ctrl.signal,
        });
        const realAssistantId = res.headers.get('X-Assistant-Message-Id');
        if (realAssistantId) {
          setMessages((prev) =>
            prev.map((m) => (m.id === tempAssistantId ? { ...m, id: realAssistantId } : m)),
          );
        }
        await consumeStream(res, realAssistantId ?? tempAssistantId);
        setStatus('idle');
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          setMessages((prev) =>
            prev.filter((m) => !(m.id === tempAssistantId && m.role === 'assistant')),
          );
          return;
        }
        const message = err instanceof Error ? err.message : 'Stream failed';
        setError(message);
        setStatus('error');
      } finally {
        abortRef.current = null;
      }
    },
    [consumeStream, status],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
  }, []);

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      await uploadDocuments(files, {
        ensureThread: async () => {
          const res = await fetch('/api/threads', { method: 'POST' });
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(`Could not create thread: ${body?.error ?? res.status}`);
          }
          const body = (await res.json()) as { thread: { id: string } };
          const newThreadId = body.thread.id;
          setThreadId(newThreadId);
          // Mirror the pattern in `send`: bump the ref before router.replace so
          // the prop-sync effect doesn't treat the URL change as an external
          // nav and wipe local state mid-upload.
          lastSyncedActiveThreadIdRef.current = newThreadId;
          router.replace(`/chat?thread=${newThreadId}`);
          return newThreadId;
        },
      });
    },
    [router, uploadDocuments],
  );

  return (
    <div className="flex flex-1">
      <aside className="hidden w-64 flex-col gap-1 border-r p-3 sm:flex">
        <Button
          variant="outline"
          size="sm"
          className="mb-1 w-full justify-start"
          onClick={handleNewChat}
        >
          <Plus className="size-4" /> New chat
        </Button>
        <h2 className="px-2 text-xs font-medium uppercase text-muted-foreground">Threads</h2>
        {threads.length === 0 && (
          <p className="px-2 text-sm text-muted-foreground">No threads yet.</p>
        )}
        {threads.map((t) => (
          <div
            key={t.id}
            data-active={t.id === threadId ? 'true' : undefined}
            className="group flex items-center gap-1"
          >
            <Link
              href={`/chat?thread=${t.id}`}
              aria-current={t.id === threadId ? 'page' : undefined}
              className={`flex-1 truncate rounded-md px-2 py-1.5 text-sm hover:bg-muted ${
                t.id === threadId ? 'bg-muted font-medium' : ''
              }`}
            >
              {t.title ?? 'Untitled'}
            </Link>
            <button
              type="button"
              onClick={() => setPendingDeleteId(t.id)}
              className="rounded-md p-1.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-data-[active=true]:opacity-100"
              aria-label={`Delete thread ${t.title ?? 'Untitled'}`}
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
      </aside>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
        <header className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold">Chat</h1>
          <span className="text-xs text-muted-foreground">claude-sonnet-4-6 · via Inngest</span>
        </header>

        <div
          role="log"
          aria-live="polite"
          className="flex flex-1 flex-col gap-4 overflow-y-auto rounded-lg border p-4"
        >
          {messages.length === 0 && (
            <p className="text-sm text-muted-foreground">Say hello to start.</p>
          )}
          {messages.map((m) => (
            <div key={m.id} className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{m.role}</span>
                {m.role === 'assistant' && !m.id.startsWith('local-') && status === 'idle' && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => regenerate(m.id)}>
                    Regenerate
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-2 text-sm">
                {m.parts && m.role === 'assistant' ? (
                  m.parts.map((p, i) => {
                    // Parts for a stored message are append-only and never
                    // reordered, so index-with-message-id is a stable key.
                    // For tool parts we have a real `toolCallId` — prefer it.
                    const key =
                      p.type === 'tool-call' || p.type === 'tool-result'
                        ? `${p.type}-${p.toolCallId}`
                        : `${m.id}-text-${i}`;
                    if (p.type === 'text') {
                      return <Streamdown key={key}>{p.text}</Streamdown>;
                    }
                    if (p.type === 'tool-call') {
                      return (
                        <details key={key} className="rounded-md border bg-muted/40 p-2 text-xs">
                          <summary className="cursor-pointer font-mono">
                            ▶ {p.toolName}({JSON.stringify(p.args)})
                          </summary>
                        </details>
                      );
                    }
                    return (
                      <details key={key} className="rounded-md border bg-muted/40 p-2 text-xs">
                        <summary className="cursor-pointer font-mono">
                          ↩ {p.toolName} result
                        </summary>
                        <pre className="mt-2 overflow-x-auto">
                          {JSON.stringify(p.result, null, 2)}
                        </pre>
                      </details>
                    );
                  })
                ) : m.role === 'assistant' ? (
                  <Streamdown>{m.text || (status === 'streaming' ? '…' : '')}</Streamdown>
                ) : (
                  <p className="whitespace-pre-wrap">{m.text}</p>
                )}
              </div>
            </div>
          ))}
          {error && <p className="text-sm text-destructive">Error: {error}</p>}
        </div>

        <DocumentChipRail documents={documents} onDismiss={dismissDocument} />

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (!e.dataTransfer.files.length) return;
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
            title="Attach document"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="size-4" />
          </Button>
          <label htmlFor={inputId} className="sr-only">
            Message
          </label>
          <input
            id={inputId}
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            placeholder="Type a message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={status === 'streaming'}
          />
          {status === 'streaming' ? (
            <Button type="button" variant="outline" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim()}>
              Send
            </Button>
          )}
        </form>
      </main>

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (open || isDeleting) return;
          setPendingDeleteId(null);
          setDeleteError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete thread?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{pendingThread?.title ?? 'Untitled'}&rdquo; and all of its messages will be
              permanently deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p className="text-sm text-destructive">Error: {deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
            >
              {isDeleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function parseSseFrame(frame: string): { event: string; data: Record<string, unknown> } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
  } catch {
    return null;
  }
}
