export type DocumentKind = 'pdf' | 'docx' | 'md' | 'txt';

export interface Chunk {
  chunk_index: number;
  content: string;
  token_count: number;
}
