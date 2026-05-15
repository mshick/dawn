import { anthropic } from '@ai-sdk/anthropic';
import { type ModelMessage, stepCountIs, streamText } from 'ai';
import { createDocumentTools } from '@/lib/ai/tools/documents';
import { adminDb } from '@/lib/db/admin';
import type { Json } from '@/lib/db/database.types';
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

    const history = rows.filter(
      (r): r is { role: 'user' | 'assistant' | 'system'; content: string } =>
        r.role === 'user' || r.role === 'assistant' || r.role === 'system',
    );

    // Anthropic prompt caching: place a cache_control breakpoint on the last
    // message so the entire prior transcript caches incrementally. Each turn,
    // the previous turn's breakpoint becomes a cache read for the prefix up to
    // that point, and a new breakpoint extends the cache to the new boundary.
    // System prompt + tool definitions get their own breakpoint below.
    const messages: ModelMessage[] = history.map((r, i) => {
      const base: ModelMessage = { role: r.role, content: r.content };
      if (i === history.length - 1) {
        return {
          ...base,
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        };
      }
      return base;
    });

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
      const tools = createDocumentTools({ threadId });

      const SYSTEM_PROMPT =
        'You are a helpful assistant. ' +
        'Documents may be attached to this conversation. When the user references one, prefer calling search_corpus over guessing. ' +
        'Use get_chunk_neighbors to expand context around a relevant chunk. ' +
        "Use get_document_metadata only when the user asks about a document's structure.";

      // Render order is tools → system → messages. A cache_control breakpoint
      // on the system block caches both tool definitions and the system prompt
      // together, since both are stable for the lifetime of the conversation.
      const result = streamText({
        model: anthropic(CLAUDE_MODEL),
        maxOutputTokens: MAX_TOKENS,
        system: {
          role: 'system',
          content: SYSTEM_PROMPT,
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
        messages,
        tools,
        stopWhen: stepCountIs(5),
      });

      const parts: Array<Record<string, unknown>> = [];
      let currentText = '';

      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          const t = part.text;
          if (!t) continue;
          buffer += t;
          currentText += t;
          inngest.realtime.publish(channel.delta, { text: t }).catch((err) => {
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
        } else if (part.type === 'text-end' || part.type === 'finish-step') {
          if (currentText) {
            parts.push({ type: 'text', text: currentText });
            currentText = '';
          }
        } else if (part.type === 'tool-call') {
          parts.push({
            type: 'tool-call',
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            args: part.input,
          });
        } else if (part.type === 'tool-result') {
          parts.push({
            type: 'tool-result',
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            result: part.output,
          });
        } else if (part.type === 'error') {
          throw part.error;
        }
      }
      if (currentText) parts.push({ type: 'text', text: currentText });

      if (pendingFlush) await pendingFlush;

      const [finishReason, usage] = await Promise.all([result.finishReason, result.usage]);
      const completedAt = new Date();
      const latencyMs = completedAt.getTime() - startedAt;

      logger.info('chat-stream completed', {
        streamId,
        threadId,
        latencyMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
        cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
      });

      await adminDb
        .updateTable('messages')
        .set({
          content: buffer,
          // pg driver doesn't auto-stringify JS objects/arrays for jsonb columns;
          // pass valid JSON text. Cast: the generated `Json` type expects the parsed
          // shape, but at the wire level a JSON string is what jsonb accepts.
          parts: JSON.stringify(parts) as unknown as Json,
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

export { documentIngest } from './document-ingest';

import { documentIngest } from './document-ingest';

export const functions = [chatStream, chatStreamTimeoutCleanup, documentIngest];
