import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Anchor the workspace/tracing root explicitly. Without this, Next 16 walks up
  // the directory tree (or hits our `pnpm-workspace.yaml`) and infers the wrong
  // root, which breaks resolution of CSS imports like `@import "tailwindcss"`
  // in dev (Turbopack and webpack-fallback).
  outputFileTracingRoot: projectRoot,
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
