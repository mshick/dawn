import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/admin', () => ({ adminDb: {} }));
vi.mock('@/lib/documents/embed', () => ({ embedChunks: vi.fn() }));

import { createDocumentTools } from './documents';

describe('createDocumentTools', () => {
  it('returns three named tools', () => {
    const tools = createDocumentTools({ threadId: 't-1' });
    expect(Object.keys(tools).sort()).toEqual([
      'get_chunk_neighbors',
      'get_document_metadata',
      'search_corpus',
    ]);
  });

  it('search_corpus parameters include query and optional k', () => {
    const tools = createDocumentTools({ threadId: 't-1' });
    // tool() exposes the zod schema as `inputSchema` (AI SDK v6).
    const schema = (tools.search_corpus as { inputSchema: { parse: (v: unknown) => unknown } })
      .inputSchema;
    expect(() => schema.parse({ query: 'hi' })).not.toThrow();
    expect(() => schema.parse({ query: 'hi', k: 8 })).not.toThrow();
    expect(() => schema.parse({ query: '' })).toThrow();
    expect(() => schema.parse({ query: 'hi', k: 21 })).toThrow();
  });
});
