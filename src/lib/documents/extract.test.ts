import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generateTextMock, extractRawTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  extractRawTextMock: vi.fn(),
}));

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, generateText: generateTextMock };
});

vi.mock('mammoth', () => ({
  default: { extractRawText: extractRawTextMock },
  extractRawText: extractRawTextMock,
}));

import { ExtractEmptyError, ExtractTooLargeError, extractText } from './extract';

const enc = new TextEncoder();

beforeEach(() => {
  generateTextMock.mockReset();
  extractRawTextMock.mockReset();
});

describe('extractText (txt)', () => {
  it('decodes utf-8', async () => {
    const bytes = enc.encode('hello world');
    await expect(
      extractText({ kind: 'txt', bytes, byteSize: bytes.length }),
    ).resolves.toBe('hello world');
  });
});

describe('extractText (md)', () => {
  it('preserves markdown', async () => {
    const bytes = enc.encode('# Title\n\n**bold**');
    await expect(
      extractText({ kind: 'md', bytes, byteSize: bytes.length }),
    ).resolves.toBe('# Title\n\n**bold**');
  });
});

describe('extractText (docx)', () => {
  it('calls mammoth.extractRawText', async () => {
    extractRawTextMock.mockResolvedValueOnce({ value: 'docx text' });
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(extractText({ kind: 'docx', bytes, byteSize: 3 })).resolves.toBe(
      'docx text',
    );
    expect(extractRawTextMock).toHaveBeenCalledOnce();
  });
});

describe('extractText (pdf)', () => {
  it('calls Anthropic Haiku and returns text', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'extracted pdf text',
      finishReason: 'stop',
    });
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    await expect(
      extractText({ kind: 'pdf', bytes, byteSize: bytes.length }),
    ).resolves.toBe('extracted pdf text');
    expect(generateTextMock).toHaveBeenCalledOnce();
  });

  it('throws ExtractTooLargeError on finishReason=length', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'partial',
      finishReason: 'length',
    });
    await expect(
      extractText({ kind: 'pdf', bytes: new Uint8Array(200_000), byteSize: 200_000 }),
    ).rejects.toBeInstanceOf(ExtractTooLargeError);
  });

  it('throws ExtractEmptyError when result is tiny and source is big (scanned PDF)', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'hi', finishReason: 'stop' });
    await expect(
      extractText({ kind: 'pdf', bytes: new Uint8Array(200_000), byteSize: 200_000 }),
    ).rejects.toBeInstanceOf(ExtractEmptyError);
  });
});
