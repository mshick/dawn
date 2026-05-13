import 'server-only';

import { createOpenAI } from '@ai-sdk/openai';
import { embedMany } from 'ai';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;
const BATCH_SIZE = 96;

let _model: ReturnType<ReturnType<typeof createOpenAI>['embedding']> | null = null;
function model() {
  if (!_model) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    _model = createOpenAI({ apiKey }).embedding(EMBEDDING_MODEL);
  }
  return _model;
}

export interface EmbedResult {
  model: typeof EMBEDDING_MODEL;
  vectors: number[][];
}

export async function embedChunks(inputs: string[]): Promise<EmbedResult> {
  const vectors: number[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch = inputs.slice(i, i + BATCH_SIZE);
    const { embeddings } = await embedMany({
      model: model(),
      values: batch,
    });
    for (const embedding of embeddings) {
      vectors.push(embedding);
    }
  }
  return { model: EMBEDDING_MODEL, vectors };
}
