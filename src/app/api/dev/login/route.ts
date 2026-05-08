import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient as createServerSupabase } from '@/lib/supabase/server';

const bodySchema = z.object({
  email: z.string().email(),
  // Single leading slash, not "//" — open-redirect protection,
  // mirrors src/app/auth/callback/route.ts.
  next: z
    .string()
    .regex(/^\/(?!\/)/)
    .optional(),
});

const ALREADY_REGISTERED_CODE = 'user_already_exists';
const ALREADY_REGISTERED_PATTERNS = [/already.*registered/i, /already exists/i];

function isAlreadyRegistered(
  error: { message?: string; code?: string } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === ALREADY_REGISTERED_CODE) return true;
  return ALREADY_REGISTERED_PATTERNS.some((p) => p.test(error.message ?? ''));
}

export async function POST(req: Request): Promise<Response> {
  // Read process.env directly (not the cached env from @/lib/env) so the
  // gate works even if Zod parsing of env at startup failed, and so tests
  // can mutate the flag per-case. The /login page uses env.ts as a second
  // independent check.
  if (process.env.DEV_AUTH_ENABLED !== '1') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { email } = parsed.data;
  const next = parsed.data.next ?? '/chat';

  const admin = createAdminClient();

  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error && !isAlreadyRegistered(created.error)) {
    return NextResponse.json({ error: created.error.message }, { status: 500 });
  }

  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (link.error || !link.data?.properties?.hashed_token) {
    return NextResponse.json(
      { error: link.error?.message ?? 'generate_link_failed' },
      { status: 500 },
    );
  }
  const tokenHash = link.data.properties.hashed_token;

  const supabase = await createServerSupabase();
  // 'email' is the OTP type for magic-link hashed tokens in @supabase/supabase-js
  // v2. Older SDKs used 'magiclink' here — match the installed type definition
  // if upgrading.
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: 'email',
    token_hash: tokenHash,
  });
  if (verifyError) {
    return NextResponse.json({ error: verifyError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, next });
}
