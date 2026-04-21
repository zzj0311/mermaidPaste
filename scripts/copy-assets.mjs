import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const dist = path.join(root, 'dist');

async function copy(src, dst) {
  if (!existsSync(src)) return;
  await mkdir(path.dirname(dst), { recursive: true });
  await cp(src, dst, { recursive: true });
}

await mkdir(dist, { recursive: true });

await copy(
  path.join(root, 'src', 'renderer', 'index.html'),
  path.join(dist, 'renderer', 'index.html')
);

console.log('[copy-assets] done');
