import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/* (static, image, webpack-hmr, turbopack-hmr, data, …)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     *
     * Excluding the full _next/ namespace matters for HMR: without it the
     * proxy runs (and calls supabase.auth.getUser) on every websocket
     * upgrade request, which breaks fast refresh and leaves the client
     * unhydrated.
     */
    '/((?!_next/|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};
