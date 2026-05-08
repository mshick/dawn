import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ChatView } from './chat-view';

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

  let messages: { id: string; role: string; content: string; superseded_at: string | null }[] = [];
  if (activeThreadId) {
    const { data } = await supabase
      .from('messages')
      .select('id, role, content, superseded_at')
      .eq('thread_id', activeThreadId)
      .is('superseded_at', null)
      .order('created_at', { ascending: true });
    messages = data ?? [];
  }

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
        }))}
    />
  );
}
