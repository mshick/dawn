import { Button } from '@/components/ui/button';
import { signInWithGitHub, signInWithGoogle } from './actions';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

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
        <form action={signInWithGoogle}>
          <Button type="submit" className="w-full" variant="outline">
            Continue with Google
          </Button>
        </form>
      </div>
    </main>
  );
}
