#!/usr/bin/env node
/**
 * Interactive bootstrap for a freshly cloned copy of this template.
 *
 * Prompts for a project slug + display name and rewrites every place the old
 * name appears (package.json, supabase/config.toml, the Inngest app id, the
 * UI titles in the App Router, CLAUDE.md). Idempotent — re-running it just
 * uses whatever the current slug/title is as the new default.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Files we touch and the kind of substitution each one needs. `kind: 'slug'`
// uses the package-name style identifier; `kind: 'title'` uses the human
// display name.
const targets = [
  {
    path: 'package.json',
    kind: 'slug',
    read: (s) => JSON.parse(s).name,
    apply: (s, _old, next) => s.replace(/("name"\s*:\s*)"[^"]*"/, `$1"${next}"`),
  },
  {
    path: 'supabase/config.toml',
    kind: 'slug',
    read: (s) => s.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1],
    apply: (s, _old, next) => s.replace(/^(project_id\s*=\s*)"[^"]*"/m, `$1"${next}"`),
  },
  {
    path: 'src/lib/inngest/client.ts',
    kind: 'slug',
    read: (s) => s.match(/id:\s*['"]([^'"]+)['"]/)?.[1],
    apply: (s, _old, next) => s.replace(/(id:\s*)['"][^'"]*['"]/, `$1'${next}'`),
  },
  {
    path: 'src/app/layout.tsx',
    kind: 'title',
    read: (s) => s.match(/title:\s*['"]([^'"]+)['"]/)?.[1],
    apply: (s, _old, next) => s.replace(/(title:\s*)['"][^'"]*['"]/, `$1'${escapeSingle(next)}'`),
  },
  {
    path: 'src/app/page.tsx',
    kind: 'title',
    // Read from the inferred old title rather than parsing JSX.
    read: () => null,
    apply: (s, _old, next) =>
      s.replace(
        /(<h1 className="text-4xl font-semibold tracking-tight">)[^<]*(<\/h1>)/,
        `$1${escapeJsx(next)}$2`,
      ),
  },
  {
    path: 'src/app/login/page.tsx',
    kind: 'title',
    read: (s) => s.match(/<h1 className="text-2xl font-semibold">Sign in to ([^<]+)<\/h1>/)?.[1],
    apply: (s, _old, next) =>
      s.replace(
        /(<h1 className="text-2xl font-semibold">Sign in to )[^<]*(<\/h1>)/,
        `$1${escapeJsx(next)}$2`,
      ),
  },
  {
    path: 'CLAUDE.md',
    kind: 'title',
    read: (s) => s.match(/^#\s+(.+)$/m)?.[1],
    apply: (s, _old, next) => s.replace(/^#\s+.+$/m, `# ${next}`),
  },
];

function escapeSingle(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeJsx(s) {
  return s.replace(/[<>{}]/g, (c) => `{'${c}'}`);
}

function slugify(s) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isValidSlug(s) {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s);
}

function readFile(rel) {
  return readFileSync(resolve(root, rel), 'utf8');
}

function writeFile(rel, contents) {
  writeFileSync(resolve(root, rel), contents);
}

function detectCurrent() {
  // Slug source of truth: package.json "name".
  const pkg = JSON.parse(readFile('package.json'));
  const currentSlug = pkg.name ?? slugify(basename(root));

  // Title source of truth: layout.tsx metadata.title (falls back to slug).
  const layout = readFile('src/app/layout.tsx');
  const currentTitle = layout.match(/title:\s*['"]([^'"]+)['"]/)?.[1] ?? currentSlug;

  return { currentSlug, currentTitle };
}

async function main() {
  const { currentSlug, currentTitle } = detectCurrent();

  const rl = createInterface({ input: stdin, output: stdout });

  console.log('Bootstrap a fresh copy of this template.');
  console.log(`Current project slug: ${currentSlug}`);
  console.log(`Current display name: ${currentTitle}`);
  console.log('');

  let slug = '';
  while (!slug) {
    const answer = (
      await rl.question(`Project slug (lowercase, hyphens) [${currentSlug}]: `)
    ).trim();
    const candidate = answer || currentSlug;
    if (!isValidSlug(candidate)) {
      console.log(
        `  "${candidate}" isn't a valid slug. Use lowercase letters, digits, and hyphens (e.g. my-app).`,
      );
      continue;
    }
    slug = candidate;
  }

  const titleDefault = currentTitle === currentSlug ? slug : currentTitle;
  const titleAnswer = (
    await rl.question(`Display name (UI titles, headings) [${titleDefault}]: `)
  ).trim();
  const title = titleAnswer || titleDefault;

  console.log('');
  console.log('About to update:');
  console.log(`  slug   : ${currentSlug} -> ${slug}`);
  console.log(`  title  : ${currentTitle} -> ${title}`);
  console.log('');
  const confirm = (await rl.question('Proceed? [Y/n]: ')).trim().toLowerCase();
  rl.close();

  if (confirm && confirm !== 'y' && confirm !== 'yes') {
    console.log('Aborted.');
    process.exit(0);
  }

  let touched = 0;
  for (const target of targets) {
    const before = readFile(target.path);
    const next = target.kind === 'slug' ? slug : title;
    const old = target.kind === 'slug' ? currentSlug : currentTitle;
    const after = target.apply(before, old, next);
    if (after !== before) {
      writeFile(target.path, after);
      console.log(`  updated ${target.path}`);
      touched++;
    } else {
      console.log(`  unchanged ${target.path}`);
    }
  }

  console.log('');
  console.log(`Done. ${touched} file${touched === 1 ? '' : 's'} updated.`);
  console.log('Next steps:');
  console.log('  1. cp .env.example .env.local  (and fill it in)');
  console.log('  2. pnpm install');
  console.log('  3. pnpm db:start && pnpm dev');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
