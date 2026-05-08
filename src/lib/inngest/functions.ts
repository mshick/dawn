import { anthropic } from '@ai-sdk/anthropic';
import { type ModelMessage, streamText } from 'ai';
import { adminDb } from '@/lib/db/admin';
import { chatChannel } from './channels';
import { inngest } from './client';

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8192;
const DEBOUNCE_MS = 250;

interface ChatRequestPayload {
  streamId: string;
  threadId: string;
  assistantMessageId: string;
}

export const chatStream = inngest.createFunction(
  {
    id: 'chat-stream',
    name: 'Chat: stream Claude response',
    triggers: [{ event: 'chat/message.requested' }],
    concurrency: { limit: 50 },
  },
  async ({ event, runId, logger }) => {
    const { streamId, threadId, assistantMessageId } = event.data as ChatRequestPayload;
    const channel = chatChannel(streamId);
    const startedAt = Date.now();

    if (!process.env.ANTHROPIC_API_KEY) {
      const message = 'ANTHROPIC_API_KEY is not configured on the server.';
      await Promise.all([
        inngest.realtime.publish(channel.error, { message }),
        adminDb
          .updateTable('messages')
          .set({
            finish_reason: 'error',
            completed_at: new Date().toISOString(),
            content: '',
            inngest_run_id: runId,
            model: CLAUDE_MODEL,
          })
          .where('id', '=', assistantMessageId)
          .execute(),
      ]);
      return { ok: false as const, reason: 'missing_api_key' };
    }

    // Load active history (exclude the empty assistant placeholder).
    const rows = await adminDb
      .selectFrom('messages')
      .select(['role', 'content'])
      .where('thread_id', '=', threadId)
      .where('superseded_at', 'is', null)
      .where('id', '!=', assistantMessageId)
      .where('content', '!=', '')
      .orderBy('created_at', 'asc')
      .execute();

    const messages: ModelMessage[] = rows
      .filter(
        (r): r is { role: 'user' | 'assistant' | 'system'; content: string } =>
          r.role === 'user' || r.role === 'assistant' || r.role === 'system',
      )
      .map((r) => ({ role: r.role, content: r.content }));

    let buffer = '';
    let lastFlushAt = 0;
    let pendingFlush: Promise<unknown> | null = null;

    const flush = async () => {
      const snapshot = buffer;
      try {
        await adminDb
          .updateTable('messages')
          .set({ content: snapshot })
          .where('id', '=', assistantMessageId)
          .execute();
      } catch (err) {
        logger.warn('debounced flush failed', { err });
      } finally {
        lastFlushAt = Date.now();
      }
    };

    try {
      const result = streamText({
        model: anthropic(CLAUDE_MODEL),
        maxOutputTokens: MAX_TOKENS,
        messages,
      });

      for await (const text of result.textStream) {
        if (!text) continue;
        buffer += text;
        inngest.realtime.publish(channel.delta, { text }).catch((err) => {
          logger.warn('realtime delta publish failed', {
            err: err instanceof Error ? err.message : String(err),
          });
        });

        const now = Date.now();
        if (now - lastFlushAt >= DEBOUNCE_MS && !pendingFlush) {
          pendingFlush = flush().finally(() => {
            pendingFlush = null;
          });
        }
      }

      if (pendingFlush) await pendingFlush;

      const [finishReason, usage] = await Promise.all([result.finishReason, result.usage]);
      const completedAt = new Date();
      const latencyMs = completedAt.getTime() - startedAt;

      await adminDb
        .updateTable('messages')
        .set({
          content: buffer,
          completed_at: completedAt.toISOString(),
          finish_reason: finishReason ?? null,
          model: CLAUDE_MODEL,
          input_tokens: usage.inputTokens ?? null,
          output_tokens: usage.outputTokens ?? null,
          latency_ms: latencyMs,
          inngest_run_id: runId,
        })
        .where('id', '=', assistantMessageId)
        .execute();

      await inngest.realtime.publish(channel.done, { stopReason: finishReason ?? null });

      return {
        ok: true as const,
        stopReason: finishReason ?? null,
        outputTokens: usage.outputTokens,
        latencyMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const erroredAt = new Date();
      logger.error('chat-stream failed', { streamId, threadId, message });

      await Promise.all([
        inngest.realtime.publish(channel.error, { message }),
        adminDb
          .updateTable('messages')
          .set({
            content: buffer,
            completed_at: erroredAt.toISOString(),
            finish_reason: 'error',
            model: CLAUDE_MODEL,
            inngest_run_id: runId,
            latency_ms: erroredAt.getTime() - startedAt,
          })
          .where('id', '=', assistantMessageId)
          .execute(),
      ]);

      return { ok: false as const, reason: 'stream_error', message };
    }
  },
);

export const chatStreamTimeoutCleanup = inngest.createFunction(
  {
    id: 'chat-stream-timeout-cleanup',
    name: 'Chat: mark stuck streams as timed out',
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async ({ logger }) => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const updated = await adminDb
      .updateTable('messages')
      .set({ finish_reason: 'timeout', completed_at: new Date().toISOString() })
      .where('completed_at', 'is', null)
      .where('created_at', '<', fiveMinAgo.toISOString())
      .where('role', '=', 'assistant')
      .returning(['id'])
      .execute();
    if (updated.length > 0) {
      logger.info('marked stuck assistant messages as timed out', { count: updated.length });
    }
    return { count: updated.length };
  },
);

export const functions = [chatStream, chatStreamTimeoutCleanup];
