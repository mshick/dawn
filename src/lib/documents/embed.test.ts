import { beforeEach, describe, expect, it, vi } from 'vitest';

const { embedManyMock } = vi.hoisted(() => ({
  embedManyMock: vi.fn(),
}));

vi.mock('ai', () => ({
  embedMany: embedManyMock,
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => ({ embedding: () => ({}) }),
}));

import { EMBEDDING_MODEL, embedChunks } from './embed';

beforeEach(() => {
  embedManyMock.mockReset();
  process.env.OPENAI_API_KEY = 'test-key';
});

const fakeVector = (seed: number) => Array.from({ length: 1536 }, (_, i) => (seed + i) / 10000);

describe('embedChunks', () => {
  it('returns model id and parallel vectors', async () => {
    embedManyMock.mockResolvedValueOnce({
      embeddings: [fakeVector(1), fakeVector(2)],
    });
    const out = await embedChunks(['a', 'b']);
    expect(out.model).toBe(EMBEDDING_MODEL);
    expect(out.vectors).toHaveLength(2);
    expect(out.vectors[0]).toHaveLength(1536);
  });

  it('batches when input length > 96', async () => {
    const first = Array.from({ length: 96 }, (_, i) => fakeVector(i));
    const second = Array.from({ length: 4 }, (_, i) => fakeVector(96 + i));
    embedManyMock
      .mockResolvedValueOnce({ embeddings: first })
      .mockResolvedValueOnce({ embeddings: second });

    const inputs = Array.from({ length: 100 }, (_, i) => `chunk ${i}`);
    const out = await embedChunks(inputs);
    expect(embedManyMock).toHaveBeenCalledTimes(2);
    expect(out.vectors).toHaveLength(100);
  });

  it('propagates errors', async () => {
    embedManyMock.mockRejectedValueOnce(new Error('rate limited'));
    await expect(embedChunks(['x'])).rejects.toThrow('rate limited');
  });
});
