'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

async function signInWith(provider: 'github' | 'google') {
  const supabase = await createClient();
  const origin = (await headers()).get('origin') ?? 'http://localhost:3000';

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${origin}/auth/callback?next=/chat` },
  });

  if (error || !data.url) {
    redirect(`/login?error=${encodeURIComponent(error?.message ?? 'oauth_failed')}`);
  }

  redirect(data.url);
}

export async function signInWithGitHub() {
  await signInWith('github');
}

export async function signInWithGoogle() {
  await signInWith('google');
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
