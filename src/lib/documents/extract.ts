import 'server-only';

import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import mammoth from 'mammoth';
import type { DocumentKind } from './types';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const HAIKU_MAX_OUTPUT_TOKENS = 32_000;
const PDF_EXTRACT_PROMPT =
  'Extract all text from this PDF in reading order. Preserve paragraph breaks. Do not summarize, comment, or add anything.';
const SCANNED_PDF_OUTPUT_THRESHOLD = 50;
const SCANNED_PDF_INPUT_BYTES = 100 * 1024;

export class ExtractTooLargeError extends Error {
  readonly code = 'extract_too_large';
}
export class ExtractEmptyError extends Error {
  readonly code = 'extract_empty';
}

export interface ExtractArgs {
  kind: DocumentKind;
  bytes: Uint8Array;
  byteSize: number;
}

export async function extractText({ kind, bytes, byteSize }: ExtractArgs): Promise<string> {
  switch (kind) {
    case 'txt':
    case 'md':
      return new TextDecoder('utf-8').decode(bytes);
    case 'docx': {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      return result.value;
    }
    case 'pdf': {
      const result = await generateText({
        model: anthropic(HAIKU_MODEL),
        maxOutputTokens: HAIKU_MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PDF_EXTRACT_PROMPT },
              { type: 'file', mediaType: 'application/pdf', data: bytes },
            ],
          },
        ],
      });
      if (result.finishReason === 'length') {
        throw new ExtractTooLargeError('PDF exceeded extractor max output');
      }
      const text = result.text.trim();
      if (text.length < SCANNED_PDF_OUTPUT_THRESHOLD && byteSize > SCANNED_PDF_INPUT_BYTES) {
        throw new ExtractEmptyError(
          'PDF produced almost no text (likely scanned/image-only)',
        );
      }
      return text;
    }
  }
}
