import { channel } from 'inngest/realtime';
import { z } from 'zod';

/**
 * Realtime channel for a single chat run, scoped by stream id.
 *
 * The Inngest function publishes:
 *  - `delta` for each text chunk from Claude
 *  - `done` once the model has finished (with stop reason)
 *  - `error` if anything blew up server-side
 */
export const chatChannel = channel({
  name: (streamId: string) => `chat:${streamId}`,
  topics: {
    delta: { schema: z.object({ text: z.string() }) },
    done: { schema: z.object({ stopReason: z.string().nullable().optional() }) },
    error: { schema: z.object({ message: z.string() }) },
  },
});
