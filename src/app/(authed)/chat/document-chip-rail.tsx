'use client';

import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import type { ThreadDocument } from './use-thread-documents';

export function DocumentChipRail({ documents }: { documents: ThreadDocument[] }) {
  if (documents.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {documents.map((d) => (
        <span
          key={d.id}
          className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-1 text-xs"
          title={
            d.status === 'failed'
              ? (d.error_message ?? d.error_code ?? 'Failed')
              : `${d.kind.toUpperCase()} · ${formatBytes(d.byte_size)}`
          }
        >
          {d.status === 'processing' && <Loader2 className="size-3 animate-spin" />}
          {d.status === 'ready' && <CheckCircle2 className="size-3 text-emerald-600" />}
          {d.status === 'failed' && <AlertCircle className="size-3 text-destructive" />}
          <span className="max-w-[16ch] truncate">{d.name}</span>
        </span>
      ))}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
