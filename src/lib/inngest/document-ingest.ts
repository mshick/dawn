import { adminDb } from '@/lib/db/admin';
import { chunkText } from '@/lib/documents/chunk';
import { EMBEDDING_MODEL, embedChunks } from '@/lib/documents/embed';
import { ExtractEmptyError, ExtractTooLargeError, extractText } from '@/lib/documents/extract';
import { downloadDocumentBlob } from '@/lib/storage/documents';
import { inngest } from './client';

const CONVERSATION_TOKEN_CAP = 500_000;

interface IngestPayload {
  documentId: string;
}

export const documentIngest = inngest.createFunction(
  {
    id: 'document-ingest',
    name: 'Documents: extract → chunk → embed → index',
    triggers: [{ event: 'document/ingest.requested' }],
    concurrency: { limit: 5 },
  },
  async ({ event, step, logger }) => {
    const { documentId } = event.data as IngestPayload;

    const doc = await step.run('load-doc', async () =>
      adminDb
        .selectFrom('documents')
        .select(['id', 'thread_id', 'kind', 'storage_path', 'byte_size'])
        .where('id', '=', documentId)
        .executeTakeFirst(),
    );
    if (!doc) {
      logger.warn('document row missing', { documentId });
      return { ok: false, reason: 'missing' as const };
    }

    try {
      const text = await step.run('extract', async () => {
        const bytes = await downloadDocumentBlob(doc.storage_path);
        return extractText({
          kind: doc.kind as 'pdf' | 'docx' | 'md' | 'txt',
          bytes,
          byteSize: Number(doc.byte_size),
        });
      });

      const { chunks, totalTokens } = await step.run('chunk', async () => {
        const chunks = chunkText(text);
        const totalTokens = chunks.reduce((s, c) => s + c.token_count, 0);

        const existing = await adminDb
          .selectFrom('documents')
          .select(({ fn }) => [fn.sum<number>('token_count').as('sum')])
          .where('thread_id', '=', doc.thread_id)
          .where('status', '=', 'ready')
          .executeTakeFirst();
        const existingTotal = Number(existing?.sum ?? 0);
        if (existingTotal + totalTokens > CONVERSATION_TOKEN_CAP) {
          throw new ConversationTokenCapError(
            `would exceed per-conversation cap (${existingTotal} + ${totalTokens} > ${CONVERSATION_TOKEN_CAP})`,
          );
        }
        return { chunks, totalTokens };
      });

      const vectors = await step.run('embed', async () => {
        const { vectors } = await embedChunks(chunks.map((c) => c.content));
        return vectors;
      });

      await step.run('index', async () => {
        await adminDb.transaction().execute(async (trx) => {
          await trx
            .insertInto('chunks')
            .values(
              chunks.map((c, i) => ({
                document_id: documentId,
                thread_id: doc.thread_id,
                chunk_index: c.chunk_index,
                content: c.content,
                token_count: c.token_count,
                // pgvector accepts the array-literal text format.
                embedding: `[${vectors[i]?.join(',')}]` as unknown as never,
                embedding_model: EMBEDDING_MODEL,
              })),
            )
            .execute();

          await trx
            .updateTable('documents')
            .set({
              status: 'ready',
              token_count: totalTokens,
              chunk_count: chunks.length,
              ready_at: new Date().toISOString(),
            })
            .where('id', '=', documentId)
            .execute();
        });
      });

      return { ok: true as const, chunks: chunks.length, tokens: totalTokens };
    } catch (err) {
      const { code, message } = classifyError(err);
      logger.error('document-ingest failed', { documentId, code, message });
      await adminDb
        .updateTable('documents')
        .set({ status: 'failed', error_code: code, error_message: message })
        .where('id', '=', documentId)
        .execute();
      return { ok: false as const, code };
    }
  },
);

class ConversationTokenCapError extends Error {
  readonly code = 'conversation_token_cap';
}

function classifyError(err: unknown): { code: string; message: string } {
  if (err instanceof ExtractTooLargeError) return { code: err.code, message: err.message };
  if (err instanceof ExtractEmptyError) return { code: err.code, message: err.message };
  if (err instanceof ConversationTokenCapError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { code: 'embed_failed', message: err.message };
  return { code: 'embed_failed', message: 'unknown error' };
}
