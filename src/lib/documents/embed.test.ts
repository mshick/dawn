import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class {
    embeddings = { create: createMock };
  },
}));

import { EMBEDDING_MODEL, embedChunks } from './embed';

beforeEach(() => {
  createMock.mockReset();
  process.env.OPENAI_API_KEY = 'test-key';
});

const fakeVector = (seed: number) => Array.from({ length: 1536 }, (_, i) => (seed + i) / 10000);

describe('embedChunks', () => {
  it('returns model id and parallel vectors', async () => {
    createMock.mockResolvedValueOnce({
      data: [{ embedding: fakeVector(1) }, { embedding: fakeVector(2) }],
    });
    const out = await embedChunks(['a', 'b']);
    expect(out.model).toBe(EMBEDDING_MODEL);
    expect(out.vectors).toHaveLength(2);
    expect(out.vectors[0]).toHaveLength(1536);
  });

  it('batches when input length > 96', async () => {
    const first = Array.from({ length: 96 }, (_, i) => ({
      embedding: fakeVector(i),
    }));
    const second = Array.from({ length: 4 }, (_, i) => ({
      embedding: fakeVector(96 + i),
    }));
    createMock.mockResolvedValueOnce({ data: first }).mockResolvedValueOnce({ data: second });

    const inputs = Array.from({ length: 100 }, (_, i) => `chunk ${i}`);
    const out = await embedChunks(inputs);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(out.vectors).toHaveLength(100);
  });

  it('propagates errors', async () => {
    createMock.mockRejectedValueOnce(new Error('rate limited'));
    await expect(embedChunks(['x'])).rejects.toThrow('rate limited');
  });
});
