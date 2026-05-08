import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-8">
      <div className="flex max-w-2xl flex-col items-center gap-4 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">dawn</h1>
        <p className="text-muted-foreground">
          Next.js · TypeScript · Supabase · Kysely · Tailwind · ShadCN · Inngest · ai-sdk
        </p>
      </div>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/chat">Open chat</Link>
        </Button>
        <Button asChild variant="outline">
          <a href="https://nextjs.org/docs" target="_blank" rel="noreferrer">
            Docs
          </a>
        </Button>
      </div>
    </main>
  );
}
