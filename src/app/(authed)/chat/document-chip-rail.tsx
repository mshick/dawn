'use client';

import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { ThreadDocument } from './use-thread-documents';

interface Props {
  documents: ThreadDocument[];
  onDetach: (id: string) => Promise<void> | void;
}

export function DocumentChipRail({ documents, onDetach }: Props) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingDetachIds, setPendingDetachIds] = useState<Set<string>>(() => new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const target = documents.find((d) => d.id === pendingId) ?? null;

  if (documents.length === 0) return null;

  const onConfirm = async () => {
    if (!target) return;
    const id = target.id;
    setPendingId(null);
    setPendingDetachIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setErrorMessage(null);
    try {
      await onDetach(id);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Detach failed');
    } finally {
      setPendingDetachIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {documents.map((d) => {
          const inFlight = pendingDetachIds.has(d.id);
          const failed = d.status === 'failed';
          return (
            <span
              key={d.id}
              className="group inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-1 text-xs"
              title={
                failed
                  ? (d.error_message ?? d.error_code ?? 'Failed')
                  : `${d.kind.toUpperCase()} · ${formatBytes(d.byte_size)}`
              }
            >
              {d.status === 'processing' && <Loader2 className="size-3 animate-spin" />}
              {d.status === 'ready' && <CheckCircle2 className="size-3 text-emerald-600" />}
              {failed && <AlertCircle className="size-3 text-destructive" />}
              <span className="max-w-[16ch] truncate">{d.name}</span>
              {inFlight ? (
                <Loader2
                  data-testid={`chip-pending-${d.id}`}
                  className="size-3 animate-spin text-muted-foreground"
                />
              ) : (
                <button
                  type="button"
                  aria-label={`Detach ${d.name}`}
                  onClick={() => setPendingId(d.id)}
                  className={`rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100 ${
                    failed
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100'
                  }`}
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          );
        })}
      </div>
      {errorMessage && <p className="text-xs text-destructive">Detach failed: {errorMessage}</p>}
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setPendingId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Detach document</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium">&ldquo;{target?.name}&rdquo;</span> will be removed from
              this conversation. The assistant won&apos;t be able to retrieve from it after this.
              This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                void onConfirm();
              }}
            >
              Detach
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
