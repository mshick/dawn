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

const ALREADY_REGISTERED_PATTERNS = [
  /already.*registered/i,
  /already exists/i,
  /user_already_exists/i,
];

function isAlreadyRegistered(error: { message?: string } | null | undefined): boolean {
  if (!error?.message) return false;
  return ALREADY_REGISTERED_PATTERNS.some((p) => p.test(error.message ?? ''));
}

export async function POST(req: Request): Promise<Response> {
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
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: 'email',
    token_hash: tokenHash,
  });
  if (verifyError) {
    return NextResponse.json({ error: verifyError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, next });
}
