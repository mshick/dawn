import 'server-only';

import OpenAI from 'openai';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;
const BATCH_SIZE = 96;

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export interface EmbedResult {
  model: typeof EMBEDDING_MODEL;
  vectors: number[][];
}

export async function embedChunks(inputs: string[]): Promise<EmbedResult> {
  const vectors: number[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch = inputs.slice(i, i + BATCH_SIZE);
    const res = await client().embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    for (const item of res.data) {
      vectors.push(item.embedding);
    }
  }
  return { model: EMBEDDING_MODEL, vectors };
}
