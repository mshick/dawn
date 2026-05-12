import 'server-only';

import { adminDb } from '@/lib/db/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const thread = await adminDb
    .insertInto('threads')
    .values({ user_id: user.id, title: null })
    .returning(['id', 'title', 'created_at', 'updated_at'])
    .executeTakeFirstOrThrow();

  return Response.json({ thread }, { status: 201 });
}
