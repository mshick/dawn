import 'server-only';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './types';

const globalForAdminDb = globalThis as unknown as {
  adminDb?: Kysely<DB>;
  adminPool?: Pool;
};

function createAdminPool() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(
      'SUPABASE_DB_URL is not set. The admin (service-role) Kysely client requires it.',
    );
  }
  return new Pool({ connectionString, max: 5 });
}

/**
 * Privileged Kysely client. Connects with the postgres superuser, bypassing
 * RLS. Only import this from server code that has already validated user
 * ownership upstream — currently:
 *
 *   - The Inngest function `chatStream` (trust boundary at `/api/chat`).
 *
 * Never import from a `'use client'` file. Never import from a route handler
 * before checking `auth.getUser()`.
 */
export const adminDb: Kysely<DB> =
  globalForAdminDb.adminDb ??
  new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: globalForAdminDb.adminPool ?? createAdminPool(),
    }),
  });

if (process.env.NODE_ENV !== 'production') {
  globalForAdminDb.adminDb = adminDb;
}
