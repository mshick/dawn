import { z } from 'zod';

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_DB_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  INNGEST_EVENT_KEY: z.string().min(1).optional(),
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  SUPABASE_AUTH_GITHUB_CLIENT_ID: z.string().min(1).optional(),
  SUPABASE_AUTH_GITHUB_SECRET: z.string().min(1).optional(),
  // Local-dev only: enables /api/dev/login backdoor. Never set in production.
  DEV_AUTH_ENABLED: z.literal('1').optional(),
});

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

const _server = serverSchema.safeParse(process.env);
const _client = clientSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

if (!_server.success) {
  console.warn('[env] server vars missing or invalid:', _server.error.flatten().fieldErrors);
}
if (!_client.success) {
  console.warn('[env] client vars missing or invalid:', _client.error.flatten().fieldErrors);
}

export const env = {
  ...(_server.success ? _server.data : ({} as z.infer<typeof serverSchema>)),
  ...(_client.success ? _client.data : ({} as z.infer<typeof clientSchema>)),
};
