/** Limpia los artefactos de compilacion y empaquetado. */

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = ['dist', 'release', '.esbuild-cache'];

await Promise.all(
  TARGETS.map((target) => rm(path.join(ROOT, target), { recursive: true, force: true })),
);

console.log(`[clean] eliminados: ${TARGETS.join(', ')}`);
