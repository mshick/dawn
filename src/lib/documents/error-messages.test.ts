import { describe, expect, it } from 'vitest';
import {
  KNOWN_UPLOAD_ERROR_CODES,
  type UploadErrorCode,
  uploadErrorMessage,
} from './error-messages';

describe('uploadErrorMessage', () => {
  it('returns a non-empty, non-fallback message for every known code', () => {
    for (const code of KNOWN_UPLOAD_ERROR_CODES) {
      const msg = uploadErrorMessage(code);
      expect(msg, `code "${code}"`).toBeTruthy();
      expect(msg, `code "${code}"`).not.toBe('Upload failed. Please try again.');
    }
  });

  it('returns the generic fallback for unknown codes', () => {
    expect(uploadErrorMessage('nope')).toBe('Upload failed. Please try again.');
    expect(uploadErrorMessage(null)).toBe('Upload failed. Please try again.');
    expect(uploadErrorMessage(undefined)).toBe('Upload failed. Please try again.');
    expect(uploadErrorMessage('')).toBe('Upload failed. Please try again.');
  });

  it('pins user-visible text for codes the UI uses most', () => {
    const expected: Record<UploadErrorCode, string> = {
      too_large: 'Files must be 25 MB or smaller.',
      unsupported_type: 'Unsupported file type — try PDF, DOCX, Markdown, or plain text.',
      file_count_cap: 'This conversation already has 10 documents attached.',
      conversation_token_cap: 'This conversation is full. Detach a document to make room.',
      duplicate_name: 'A document with this name is already attached.',
      invalid_body: "Couldn't read the file. Try a different one.",
      unauthorized: 'Sign in again and reload the page.',
      not_found: 'Sign in again and reload the page.',
      extract_empty: "Couldn't extract any text — the file may be scanned or empty.",
      extract_too_large: 'Document is too long to process. Try splitting it into smaller files.',
      embed_failed: 'Processing failed. Try uploading again.',
    };
    for (const [code, message] of Object.entries(expected)) {
      expect(uploadErrorMessage(code)).toBe(message);
    }
  });
});
