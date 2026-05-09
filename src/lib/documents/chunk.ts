import { encodingForModel } from 'js-tiktoken';
import type { Chunk } from './types';

const TARGET_TOKENS = 800;
const OVERLAP_TOKENS = 100;
const SINGLE_CHUNK_THRESHOLD = 2000;
// Sentence boundaries are tight: stay within ±50 tokens to keep chunks near
// the target size. Paragraph breaks are rarer and worth a wider search — when
// one exists near the target end, snapping there is much higher quality than a
// mid-sentence cut, even if it stretches the chunk.
const SENTENCE_SNAP_WINDOW = 50;
const PARAGRAPH_SNAP_WINDOW = 250;

// `text-embedding-3-small` uses cl100k_base. js-tiktoken's `encodingForModel`
// resolves to cl100k_base for that model id. Cached at module level — the
// encoder build is non-trivial.
const enc = encodingForModel('text-embedding-3-small');

export function countTokens(text: string): number {
  if (!text) return 0;
  return enc.encode(text).length;
}

export function chunkText(text: string): Chunk[] {
  const total = countTokens(text);
  if (total === 0) return [];
  if (total < SINGLE_CHUNK_THRESHOLD) {
    return [{ chunk_index: 0, content: text, token_count: total }];
  }

  const tokens = enc.encode(text);
  const chunks: Chunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < tokens.length) {
    const targetEnd = Math.min(start + TARGET_TOKENS, tokens.length);
    let end: number;
    let content: string;
    if (targetEnd >= tokens.length) {
      end = tokens.length;
      content = enc.decode(tokens.slice(start, end));
    } else {
      const snap = snapBoundary(tokens, start, targetEnd);
      // Defensive: snapBoundary must produce strictly forward progress.
      if (snap.end <= start) {
        end = Math.min(start + TARGET_TOKENS, tokens.length);
        content = enc.decode(tokens.slice(start, end));
      } else {
        end = snap.end;
        content = snap.content;
      }
    }

    chunks.push({
      chunk_index: chunkIndex,
      content,
      // Re-count after trimming. `enc.encode` is fast on strings <1k tokens.
      token_count: content.length === 0 ? 0 : enc.encode(content).length,
    });

    if (end >= tokens.length) break;
    start = Math.max(end - OVERLAP_TOKENS, start + 1);
    chunkIndex += 1;
  }

  return chunks;
}

interface SnapResult {
  end: number; // token index (exclusive)
  content: string; // decoded chunk content (separator may be trimmed)
}

/**
 * Try to end the chunk at a paragraph break (`\n\n`) within ±PARAGRAPH_SNAP_WINDOW
 * tokens of `targetEnd`. Falls back to a sentence break (`. `, `! `, `? `) within
 * ±SENTENCE_SNAP_WINDOW tokens, then to a hard cut at `targetEnd`.
 *
 * cl100k_base sometimes merges trailing whitespace (`. \n\n`) into a single
 * token, so we cannot always land a token boundary exactly between the
 * sentence terminator and the paragraph break. When that happens we still cut
 * at the merged token but trim the trailing newlines off the content string —
 * `token_count` is recomputed by the caller from the trimmed text.
 */
function snapBoundary(tokens: number[], start: number, targetEnd: number): SnapResult {
  // 1) Paragraph break (`\n\n`). cl100k_base often merges `. \n\n` into a
  //    single token, so we locate the break in the decoded text and trim the
  //    trailing newlines off the content string. token_count is recomputed
  //    after the trim by the caller.
  const paraLo = Math.max(targetEnd - PARAGRAPH_SNAP_WINDOW, start + 1);
  const paraHi = Math.min(targetEnd + PARAGRAPH_SNAP_WINDOW, tokens.length);
  for (let dist = 0; dist <= PARAGRAPH_SNAP_WINDOW; dist++) {
    for (const sign of [-1, 1] as const) {
      const end = targetEnd + sign * dist;
      if (end < paraLo || end > paraHi) continue;
      const decoded = enc.decode(tokens.slice(start, end));
      // Look for `\n\n` near the tail. If the cut lands inside a multi-char
      // token, the `\n\n` may be at the very end (token absorbed it) or just
      // past it (next token starts with it).
      if (decoded.endsWith('\n\n')) {
        return { end, content: decoded.replace(/\n+$/, '') };
      }
      const lookahead = enc.decode(tokens.slice(end, Math.min(end + 4, tokens.length)));
      if (lookahead.startsWith('\n\n')) {
        return { end, content: decoded };
      }
      if (dist === 0) break; // avoid double-checking targetEnd
    }
  }

  // 2) Sentence break (`. `, `! `, `? `) — keep the terminator inside the chunk.
  const sentLo = Math.max(targetEnd - SENTENCE_SNAP_WINDOW, start + 1);
  const sentHi = Math.min(targetEnd + SENTENCE_SNAP_WINDOW, tokens.length);
  const terminators = ['. ', '! ', '? '];
  for (let dist = 0; dist <= SENTENCE_SNAP_WINDOW; dist++) {
    for (const sign of [-1, 1] as const) {
      const end = targetEnd + sign * dist;
      if (end < sentLo || end > sentHi) continue;
      const decoded = enc.decode(tokens.slice(start, end));
      for (const t of terminators) {
        if (decoded.endsWith(t)) {
          return { end, content: decoded };
        }
      }
      if (dist === 0) break;
    }
  }

  // 3) Hard cut.
  return { end: targetEnd, content: enc.decode(tokens.slice(start, targetEnd)) };
}
