import { describe, expect, it } from 'vitest';
import { chunkText, countTokens } from './chunk';

const PARAGRAPH = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';

describe('chunkText', () => {
  it('returns a single chunk for short input', () => {
    const chunks = chunkText('hello world');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunk_index).toBe(0);
    expect(chunks[0]?.content).toBe('hello world');
    expect(chunks[0]?.token_count).toBe(countTokens('hello world'));
  });

  it('returns one chunk when total tokens < 2000', () => {
    const text = PARAGRAPH.repeat(100); // ~800 tokens
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(text);
  });

  it('splits long text into multiple chunks indexed from 0', () => {
    const text = PARAGRAPH.repeat(500); // ~4000 tokens
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.map((c) => c.chunk_index)).toEqual(
      Array.from({ length: chunks.length }, (_, i) => i),
    );
  });

  it('non-final chunks are ~800 tokens (within ±60)', () => {
    const text = PARAGRAPH.repeat(500);
    const chunks = chunkText(text);
    for (const c of chunks.slice(0, -1)) {
      expect(c.token_count).toBeGreaterThanOrEqual(740);
      expect(c.token_count).toBeLessThanOrEqual(860);
    }
  });

  it('successive chunks overlap', () => {
    const text = PARAGRAPH.repeat(500);
    const chunks = chunkText(text);
    const a = chunks[0];
    const b = chunks[1];
    if (!a || !b) throw new Error('expected at least 2 chunks');
    const tail = a.content.slice(-200);
    expect(b.content.startsWith(tail) || b.content.includes(tail.slice(-50))).toBe(true);
  });

  it('snaps to a paragraph boundary when one is within ±50 tokens of target', () => {
    // Build text where a \n\n falls right around the 800-token target.
    const head = PARAGRAPH.repeat(99); // ~792 tokens
    const text = `${head}\n\n${PARAGRAPH.repeat(500)}`;
    const chunks = chunkText(text);
    expect(chunks[0]?.content.endsWith(head)).toBe(true);
  });
});

describe('countTokens', () => {
  it('returns a positive integer for non-empty strings', () => {
    expect(countTokens('hello world')).toBeGreaterThan(0);
  });
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });
});
