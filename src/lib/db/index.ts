import 'server-only';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './types';

const globalForDb = globalThis as unknown as {
  db?: Kysely<DB>;
  pool?: Pool;
};

function createPool() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(
      'SUPABASE_DB_URL is not set. Set it to your Supabase Postgres connection string.',
    );
  }
  return new Pool({ connectionString, max: 10 });
}

export const db: Kysely<DB> =
  globalForDb.db ??
  new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: globalForDb.pool ?? createPool(),
    }),
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.db = db;
}

export type { DB };
