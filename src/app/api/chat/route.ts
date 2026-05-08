import { subscribe } from 'inngest/realtime';
import { adminDb } from '@/lib/db/admin';
import { chatChannel } from '@/lib/inngest/channels';
import { inngest } from '@/lib/inngest/client';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

type SendBody = { thread_id?: string; content: string };
type RegenerateBody = { regenerate_message_id: string };

function isSendBody(b: unknown): b is SendBody {
  return (
    !!b && typeof b === 'object' && 'content' in b && typeof (b as SendBody).content === 'string'
  );
}

function isRegenerateBody(b: unknown): b is RegenerateBody {
  return (
    !!b &&
    typeof b === 'object' &&
    'regenerate_message_id' in b &&
    typeof (b as RegenerateBody).regenerate_message_id === 'string'
  );
}

const TITLE_MAX_LEN = 60;

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  let threadId: string;
  let assistantMessageId: string;

  if (isRegenerateBody(body)) {
    const target = await adminDb
      .selectFrom('messages')
      .innerJoin('threads', 'threads.id', 'messages.thread_id')
      .select(['messages.id', 'messages.thread_id', 'messages.role', 'threads.user_id'])
      .where('messages.id', '=', body.regenerate_message_id)
      .where('messages.superseded_at', 'is', null)
      .where('messages.completed_at', 'is not', null)
      .executeTakeFirst();

    if (!target || target.user_id !== user.id) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    if (target.role !== 'assistant') {
      return Response.json({ error: 'only_assistant_messages_regeneratable' }, { status: 400 });
    }

    threadId = target.thread_id;

    const newAssistant = await adminDb.transaction().execute(async (trx) => {
      await trx
        .updateTable('messages')
        .set({ superseded_at: new Date().toISOString() })
        .where('id', '=', body.regenerate_message_id)
        .execute();

      const inserted = await trx
        .insertInto('messages')
        .values({ thread_id: threadId, role: 'assistant', content: '' })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      await trx
        .updateTable('messages')
        .set({ superseded_by: inserted.id })
        .where('id', '=', body.regenerate_message_id)
        .execute();

      return inserted;
    });

    assistantMessageId = newAssistant.id;
  } else if (isSendBody(body)) {
    const content = body.content.trim();
    if (!content) return Response.json({ error: 'empty_content' }, { status: 400 });

    const result = await adminDb.transaction().execute(async (trx) => {
      let resolvedThreadId = body.thread_id;

      if (!resolvedThreadId) {
        const t = await trx
          .insertInto('threads')
          .values({ user_id: user.id, title: content.slice(0, TITLE_MAX_LEN) })
          .returning(['id'])
          .executeTakeFirstOrThrow();
        resolvedThreadId = t.id;
      } else {
        const owned = await trx
          .selectFrom('threads')
          .select(['id'])
          .where('id', '=', resolvedThreadId)
          .where('user_id', '=', user.id)
          .executeTakeFirst();
        if (!owned) throw new Error('thread_not_found');
      }

      await trx
        .insertInto('messages')
        .values({
          thread_id: resolvedThreadId,
          role: 'user',
          content,
          completed_at: new Date().toISOString(),
        })
        .execute();

      const assistant = await trx
        .insertInto('messages')
        .values({ thread_id: resolvedThreadId, role: 'assistant', content: '' })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      return { thread_id: resolvedThreadId, assistant_message_id: assistant.id };
    });

    threadId = result.thread_id;
    assistantMessageId = result.assistant_message_id;
  } else {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  const streamId = crypto.randomUUID();

  // Open the realtime subscription BEFORE sending the event so we don't miss
  // any deltas published by the function on a fast first token.
  const subscription = await subscribe({
    app: inngest,
    channel: chatChannel(streamId),
    topics: ['delta', 'done', 'error'],
  });

  await inngest.send({
    name: 'chat/message.requested',
    data: { streamId, threadId, assistantMessageId },
  });

  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const reader = subscription.getReader();
      try {
        while (true) {
          const { value: message, done } = await reader.read();
          if (done) break;
          if (message.topic === 'delta') {
            send('delta', message.data);
          } else if (message.topic === 'done') {
            send('done', message.data);
            break;
          } else if (message.topic === 'error') {
            send('error', message.data);
            break;
          }
        }
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : 'stream failed' });
      } finally {
        reader.releaseLock();
        await subscription.cancel().catch(() => {});
        controller.close();
      }
    },
  });

  return new Response(sse, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Stream-Id': streamId,
      'X-Thread-Id': threadId,
      'X-Assistant-Message-Id': assistantMessageId,
    },
  });
}
