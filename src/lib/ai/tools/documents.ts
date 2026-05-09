import 'server-only';

import { tool } from 'ai';
import { sql } from 'kysely';
import { z } from 'zod';
import { adminDb } from '@/lib/db/admin';
import { embedChunks } from '@/lib/documents/embed';

const RRF_K = 60;
const HALF_LIMIT = 50;

export interface CreateDocumentToolsArgs {
  threadId: string;
}

interface FusedRow {
  chunk_id: string;
  document_id: string;
  document_name: string;
  chunk_index: number;
  content: string;
  score: number;
}

export function createDocumentTools({ threadId }: CreateDocumentToolsArgs) {
  return {
    search_corpus: tool({
      description:
        'Hybrid (lexical + vector) search over the documents attached to this conversation. Returns top-k chunks with document name and a fused score. Prefer this over guessing when the user references attached material.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Natural-language query.'),
        k: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Top-k chunks to return (default 8).'),
      }),
      execute: async ({ query, k = 8 }) => {
        const [{ vectors }, lexRows] = await Promise.all([
          embedChunks([query]),
          adminDb
            .selectFrom('chunks as c')
            .innerJoin('documents as d', 'd.id', 'c.document_id')
            .select((eb) => [
              'c.id as chunk_id',
              'c.document_id',
              'd.name as document_name',
              'c.chunk_index',
              'c.content',
              eb
                .fn<number>('ts_rank_cd', [
                  eb.ref('c.fts'),
                  sql`websearch_to_tsquery('english', ${query})`,
                ])
                .as('lex_rank'),
            ])
            .where('c.thread_id', '=', threadId)
            .where('d.status', '=', 'ready')
            .where(sql`c.fts`, '@@', sql`websearch_to_tsquery('english', ${query})`)
            .orderBy('lex_rank', 'desc')
            .limit(HALF_LIMIT)
            .execute(),
        ]);

        const queryVec = vectors[0];
        if (!queryVec) return { results: [] as FusedRow[] };
        const queryVecLit = `[${queryVec.join(',')}]`;
        const vecRows = await adminDb
          .selectFrom('chunks as c')
          .innerJoin('documents as d', 'd.id', 'c.document_id')
          .select([
            'c.id as chunk_id',
            'c.document_id',
            'd.name as document_name',
            'c.chunk_index',
            'c.content',
          ])
          .where('c.thread_id', '=', threadId)
          .where('d.status', '=', 'ready')
          .orderBy(sql`c.embedding <=> ${queryVecLit}::vector`)
          .limit(HALF_LIMIT)
          .execute();

        const fused = new Map<string, FusedRow>();
        vecRows.forEach((r, i) => {
          fused.set(r.chunk_id, {
            chunk_id: r.chunk_id,
            document_id: r.document_id,
            document_name: r.document_name,
            chunk_index: r.chunk_index,
            content: r.content,
            score: 1 / (RRF_K + i + 1),
          });
        });
        lexRows.forEach((r, i) => {
          const prev = fused.get(r.chunk_id);
          const add = 1 / (RRF_K + i + 1);
          if (prev) {
            prev.score += add;
          } else {
            fused.set(r.chunk_id, {
              chunk_id: r.chunk_id,
              document_id: r.document_id,
              document_name: r.document_name,
              chunk_index: r.chunk_index,
              content: r.content,
              score: add,
            });
          }
        });

        const results = [...fused.values()]
          .sort((a, b) => b.score - a.score || (a.chunk_id < b.chunk_id ? 1 : -1))
          .slice(0, k);
        return { results };
      },
    }),

    get_chunk_neighbors: tool({
      description:
        'Return chunks adjacent to a given chunk in its source document. Use this to expand context around a chunk returned by search_corpus.',
      inputSchema: z.object({
        chunk_id: z.string(),
        before: z.number().int().min(0).max(3).optional(),
        after: z.number().int().min(0).max(3).optional(),
      }),
      execute: async ({ chunk_id, before = 1, after = 1 }) => {
        const root = await adminDb
          .selectFrom('chunks')
          .innerJoin('documents as d', 'd.id', 'chunks.document_id')
          .select(['chunks.document_id', 'chunks.chunk_index', 'chunks.thread_id'])
          .where('chunks.id', '=', chunk_id)
          .where('d.status', '=', 'ready')
          .executeTakeFirst();
        if (!root || root.thread_id !== threadId) return { chunks: [] };
        const rows = await adminDb
          .selectFrom('chunks')
          .select(['id as chunk_id', 'document_id', 'chunk_index', 'content'])
          .where('document_id', '=', root.document_id)
          .where('chunk_index', '>=', root.chunk_index - before)
          .where('chunk_index', '<=', root.chunk_index + after)
          .orderBy('chunk_index', 'asc')
          .execute();
        return { chunks: rows };
      },
    }),

    get_document_metadata: tool({
      description:
        'Return name, kind, byte size, token count, and chunk count for an attached document.',
      inputSchema: z.object({ document_id: z.string() }),
      execute: async ({ document_id }) => {
        const row = await adminDb
          .selectFrom('documents')
          .select(['id', 'name', 'kind', 'byte_size', 'token_count', 'chunk_count', 'created_at'])
          .where('id', '=', document_id)
          .where('thread_id', '=', threadId)
          .where('status', '=', 'ready')
          .executeTakeFirst();
        return row ?? null;
      },
    }),
  };
}
