import 'server-only';

import { adminDb } from '@/lib/db/admin';
import { deleteDocumentBlob } from '@/lib/storage/documents';
import { createClient } from '@/lib/supabase/server';
import { ensureOwned } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; documentId: string }> },
) {
  const { id: threadId, documentId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return err(401, 'unauthorized');
  if (!(await ensureOwned(threadId, user.id))) return err(404, 'not_found');

  const doc = await adminDb
    .selectFrom('documents')
    .select(['id', 'storage_path'])
    .where('id', '=', documentId)
    .where('thread_id', '=', threadId)
    .executeTakeFirst();
  if (!doc) return err(404, 'not_found');

  // Best-effort blob delete. An orphaned blob is recoverable by a future janitor;
  // an orphaned DB row would leave the chip rail in a broken state. Prefer DB
  // consistency over storage consistency.
  try {
    await deleteDocumentBlob(doc.storage_path);
  } catch (e) {
    console.warn(
      `[documents] storage delete failed for ${doc.storage_path}:`,
      e instanceof Error ? e.message : e,
    );
  }

  await adminDb.deleteFrom('documents').where('id', '=', documentId).execute();

  return new Response(null, { status: 204 });
}
