import 'server-only';

import { adminDb } from '@/lib/db/admin';

export async function ensureOwned(threadId: string, userId: string): Promise<boolean> {
  const t = await adminDb
    .selectFrom('threads')
    .select(['id'])
    .where('id', '=', threadId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return !!t;
}
