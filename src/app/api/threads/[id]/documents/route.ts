import 'server-only';

import { adminDb } from '@/lib/db/admin';
import { inngest } from '@/lib/inngest/client';
import {
  deleteDocumentBlob,
  documentObjectPath,
  uploadDocumentBlob,
} from '@/lib/storage/documents';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_DOCS_PER_THREAD = 10;
const TOKEN_CAP = 500_000;

const KIND_BY_MIME = new Map<string, { kind: 'pdf' | 'docx' | 'md' | 'txt'; ext: string }>([
  ['application/pdf', { kind: 'pdf', ext: 'pdf' }],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    { kind: 'docx', ext: 'docx' },
  ],
  ['text/markdown', { kind: 'md', ext: 'md' }],
  ['text/plain', { kind: 'txt', ext: 'txt' }],
]);

function err(status: number, code: string, extras: Record<string, unknown> = {}) {
  return Response.json({ error: code, ...extras }, { status });
}

async function ensureOwned(threadId: string, userId: string) {
  const t = await adminDb
    .selectFrom('threads')
    .select(['id'])
    .where('id', '=', threadId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return !!t;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: threadId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return err(401, 'unauthorized');
  if (!(await ensureOwned(threadId, user.id))) return err(404, 'not_found');

  const rows = await adminDb
    .selectFrom('documents')
    .select([
      'id',
      'name',
      'kind',
      'byte_size',
      'status',
      'error_code',
      'error_message',
      'created_at',
      'ready_at',
    ])
    .where('thread_id', '=', threadId)
    .orderBy('created_at', 'asc')
    .execute();
  return Response.json({ documents: rows });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: threadId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return err(401, 'unauthorized');
  if (!(await ensureOwned(threadId, user.id))) return err(404, 'not_found');

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err(400, 'invalid_body');
  }
  const file = form.get('file');
  if (!(file instanceof File)) return err(400, 'invalid_body');

  if (file.size > MAX_BYTES) return err(413, 'too_large');
  const k = KIND_BY_MIME.get(file.type);
  if (!k) return err(415, 'unsupported_type');

  const counts = await adminDb
    .selectFrom('documents')
    .select(({ fn }) => [
      fn.count<number>('id').as('count'),
      fn.sum<number>('token_count').as('tokens'),
    ])
    .where('thread_id', '=', threadId)
    .where('status', '!=', 'failed')
    .executeTakeFirst();
  if ((counts?.count ?? 0) >= MAX_DOCS_PER_THREAD) return err(409, 'file_count_cap');

  // Estimate: tokens ≈ bytes / 3 (generous).
  const estTokens = Math.floor(file.size / 3);
  if (Number(counts?.tokens ?? 0) + estTokens > TOKEN_CAP) {
    return err(409, 'conversation_token_cap');
  }

  const dup = await adminDb
    .selectFrom('documents')
    .select(['id'])
    .where('thread_id', '=', threadId)
    .where('name', '=', file.name)
    .executeTakeFirst();
  if (dup) return err(409, 'duplicate_name');

  const documentId = crypto.randomUUID(); // server-side; DB also defaults
  const path = documentObjectPath({
    userId: user.id,
    threadId,
    documentId,
    ext: k.ext,
  });
  const bytes = new Uint8Array(await file.arrayBuffer());

  await uploadDocumentBlob({ path, bytes, contentType: file.type });

  let inserted: { id: string };
  try {
    inserted = await adminDb
      .insertInto('documents')
      .values({
        id: documentId,
        thread_id: threadId,
        user_id: user.id,
        name: file.name,
        mime: file.type,
        byte_size: file.size,
        kind: k.kind,
        storage_path: path,
        status: 'processing',
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    await inngest.send({
      name: 'document/ingest.requested',
      data: { documentId: inserted.id },
    });
  } catch (e) {
    await deleteDocumentBlob(path).catch(() => {});
    throw e;
  }

  return Response.json(
    {
      document: {
        id: inserted.id,
        name: file.name,
        kind: k.kind,
        byte_size: file.size,
        status: 'processing',
      },
    },
    { status: 201 },
  );
}
