import { Button } from '@/components/ui/button';
import { signInWithGitHub } from './actions';
import DevSignIn from './dev-sign-in';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  // Read process.env directly to match the route handler's gate. The
  // cached env from @/lib/env can be empty if any other server var fails
  // strict Zod parsing (cascading safeParse), which would silently hide
  // this section. Server component, so the value never reaches the client.
  const devAuthEnabled = process.env.DEV_AUTH_ENABLED === '1';

  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-sm flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Sign in to dawn</h1>

      {error && (
        <p className="w-full rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex w-full flex-col gap-2">
        <form action={signInWithGitHub}>
          <Button type="submit" className="w-full" variant="outline">
            Continue with GitHub
          </Button>
        </form>
      </div>

      {devAuthEnabled && <DevSignIn />}
    </main>
  );
}
