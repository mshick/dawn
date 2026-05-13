export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_DOCS_PER_THREAD = 10;
export const CONVERSATION_TOKEN_CAP = 500_000;

export type DocumentKind = 'pdf' | 'docx' | 'md' | 'txt';

export const SUPPORTED_MIME: ReadonlyMap<string, { kind: DocumentKind; ext: string }> = new Map([
  ['application/pdf', { kind: 'pdf', ext: 'pdf' }],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    { kind: 'docx', ext: 'docx' },
  ],
  ['text/markdown', { kind: 'md', ext: 'md' }],
  ['text/plain', { kind: 'txt', ext: 'txt' }],
]);

const EXTENSION_TO_KIND: ReadonlyMap<string, DocumentKind> = new Map([
  ['pdf', 'pdf'],
  ['docx', 'docx'],
  ['md', 'md'],
  ['markdown', 'md'],
  ['txt', 'txt'],
  ['text', 'txt'],
]);

export function detectKind(file: { name: string; type: string }): DocumentKind | null {
  const byMime = SUPPORTED_MIME.get(file.type);
  if (byMime) return byMime.kind;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  return EXTENSION_TO_KIND.get(ext) ?? null;
}
