// Codes emitted by `POST /api/threads/:id/documents` and by the
// `documentIngest` Inngest function's `classifyError`. Keep this list in
// sync with both call sites — the test pins every code to a message.
export const KNOWN_UPLOAD_ERROR_CODES = [
  'too_large',
  'unsupported_type',
  'file_count_cap',
  'conversation_token_cap',
  'duplicate_name',
  'invalid_body',
  'unauthorized',
  'not_found',
  'extract_empty',
  'extract_too_large',
  'embed_failed',
] as const;

export type UploadErrorCode = (typeof KNOWN_UPLOAD_ERROR_CODES)[number];

const MESSAGES: Record<UploadErrorCode, string> = {
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

const FALLBACK = 'Upload failed. Please try again.';

export function uploadErrorMessage(code: string | null | undefined): string {
  if (!code) return FALLBACK;
  if (isKnown(code)) return MESSAGES[code];
  return FALLBACK;
}

function isKnown(code: string): code is UploadErrorCode {
  return (KNOWN_UPLOAD_ERROR_CODES as readonly string[]).includes(code);
}
