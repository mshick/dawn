'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';

export default function DevSignIn() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/dev/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        // res.json() is unknown; the route's response shape is documented at
        // src/app/api/dev/login/route.ts and the gate keeps this client-only.
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          next?: string;
          error?: string;
        } | null;
        if (!res.ok || !json?.ok) {
          setError(json?.error ?? `request_failed_${res.status}`);
          return;
        }
        router.push(json.next ?? '/chat');
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'request_failed');
      }
    });
  }

  return (
    <div className="flex w-full flex-col gap-3 border-t border-border pt-6">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">Local dev sign-in</p>
      {error && (
        <p className="w-full rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <form className="flex w-full flex-col gap-2" onSubmit={onSubmit}>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
          }}
          placeholder="you@example.com"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button type="submit" variant="secondary" className="w-full" disabled={isPending}>
          {isPending ? 'Signing in…' : 'Dev sign-in'}
        </Button>
      </form>
    </div>
  );
}
