import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

export const DOCUMENTS_BUCKET = 'documents';

export interface DocumentObjectPathArgs {
  userId: string;
  threadId: string;
  documentId: string;
  ext: string;
}

export function documentObjectPath({
  userId,
  threadId,
  documentId,
  ext,
}: DocumentObjectPathArgs): string {
  return `${userId}/${threadId}/${documentId}.${ext.toLowerCase()}`;
}

export async function uploadDocumentBlob(args: {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}) {
  const supabase = createAdminClient();
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(args.path, args.bytes, {
      contentType: args.contentType,
      upsert: false,
    });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
}

export async function downloadDocumentBlob(path: string): Promise<Uint8Array> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).download(path);
  if (error || !data) throw new Error(`storage download failed: ${error?.message ?? 'no data'}`);
  return new Uint8Array(await data.arrayBuffer());
}

export async function deleteDocumentBlob(path: string) {
  const supabase = createAdminClient();
  const { error } = await supabase.storage.from(DOCUMENTS_BUCKET).remove([path]);
  if (error) throw new Error(`storage delete failed: ${error.message}`);
}
