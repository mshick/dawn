import { redirect } from 'next/navigation';
import { adminDb } from '@/lib/db/admin';
import { createClient } from '@/lib/supabase/server';
import { ChatView, type MessagePart } from './chat-view';
import type { ThreadDocument } from './use-thread-documents';

export const dynamic = 'force-dynamic';

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}) {
  const { thread: requestedThreadId } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: threads } = await supabase
    .from('threads')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false });

  // /chat (no query) → empty state, regardless of whether the user has threads.
  // The "New chat" button relies on this: router.push('/chat') must land on a
  // fresh canvas, not the most-recent conversation.
  const activeThreadId = requestedThreadId ?? null;

  let messages: {
    id: string;
    role: string;
    content: string;
    parts: unknown;
    superseded_at: string | null;
  }[] = [];
  if (activeThreadId) {
    const { data } = await supabase
      .from('messages')
      .select('id, role, content, parts, superseded_at')
      .eq('thread_id', activeThreadId)
      .is('superseded_at', null)
      .order('created_at', { ascending: true });
    messages = data ?? [];
  }

  // Documents for the active thread (chip rail). adminDb is safe here because
  // we filter by `thread_id` belonging to the authenticated user (the threads
  // query above already ran under RLS, so the active thread is owned by them).
  const initialDocuments: ThreadDocument[] = activeThreadId
    ? (
        await adminDb
          .selectFrom('documents')
          .select([
            'id',
            'name',
            'kind',
            'byte_size',
            'status',
            'error_code',
            'error_message',
            'created_at',
            'ready_at',
          ])
          .where('thread_id', '=', activeThreadId)
          .orderBy('created_at', 'asc')
          .execute()
      ).map((d) => ({
        id: d.id,
        name: d.name,
        // DB columns are typed as `string` (Supabase generated types don't
        // narrow CHECK-constrained columns); the migration restricts these to
        // the union below.
        kind: d.kind as ThreadDocument['kind'],
        byte_size: d.byte_size,
        status: d.status as ThreadDocument['status'],
        error_code: d.error_code,
        error_message: d.error_message,
        created_at: d.created_at,
        ready_at: d.ready_at,
      }))
    : [];

  return (
    <ChatView
      threads={threads ?? []}
      activeThreadId={activeThreadId}
      initialMessages={messages
        .filter(
          (m): m is typeof m & { role: 'user' | 'assistant' | 'system' } =>
            m.role === 'user' || m.role === 'assistant' || m.role === 'system',
        )
        .map((m) => ({
          id: m.id,
          role: m.role,
          text: m.content,
          // `parts` is `Json | null` in the generated DB types; the writer
          // (Inngest chatStream) only ever stores arrays matching `MessagePart`.
          parts: m.parts as MessagePart[] | null,
        }))}
      initialDocuments={initialDocuments}
    />
  );
}
