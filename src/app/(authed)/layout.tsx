import { redirect } from 'next/navigation';
import { signOut } from '@/app/login/actions';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2 text-sm">
        <span className="text-muted-foreground">{user.email ?? user.id}</span>
        <form action={signOut}>
          <Button type="submit" size="sm" variant="ghost">
            Sign out
          </Button>
        </form>
      </header>
      <div className="flex flex-1">{children}</div>
    </div>
  );
}
