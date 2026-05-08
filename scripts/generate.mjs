#!/usr/bin/env node
/**
 * Single entrypoint for all codegen the app needs to run.
 *
 * Currently:
 *   - Regenerates `src/lib/db/database.types.ts` from the local Supabase schema.
 *
 * Designed to be safe to run any time: if Supabase isn't initialized or the
 * local stack isn't running, it logs a hint and exits 0 instead of failing dev.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const supabaseConfig = resolve(root, 'supabase/config.toml');
const typesPath = resolve(root, 'src/lib/db/database.types.ts');

function log(msg) {
  process.stdout.write(`[generate] ${msg}\n`);
}

function generateSupabaseTypes() {
  if (!existsSync(supabaseConfig)) {
    log(
      'Skipping Supabase types — no `supabase/config.toml` found. Run `pnpm supabase init` to enable.',
    );
    return;
  }

  log('Generating Supabase types from local schema…');
  const result = spawnSync(
    'pnpm',
    ['exec', 'supabase', 'gen', 'types', 'typescript', '--local', '--schema', 'public'],
    { cwd: root, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    log('Supabase type generation failed (is `supabase start` running?). Keeping previous types.');
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }

  const stdout = result.stdout ?? '';
  if (!stdout.trim()) {
    log('Supabase produced empty output — keeping existing types.');
    return;
  }

  const previous = existsSync(typesPath) ? readFileSync(typesPath, 'utf8') : '';
  if (previous === stdout) {
    log('Supabase types already up to date.');
    return;
  }

  mkdirSync(dirname(typesPath), { recursive: true });
  writeFileSync(typesPath, stdout);
  log(`Wrote ${typesPath}`);
}

generateSupabaseTypes();
