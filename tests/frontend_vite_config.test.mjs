import assert from 'node:assert/strict';
import test from 'node:test';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = fileURLToPath(new URL('../frontend/', import.meta.url));

// On Windows, Vite's config loader can report the config folder with a
// lower-case drive letter. An "@/" alias built from it made the bundler load
// every aliased module twice (two AuthContext copies crashed every page), so
// the alias must use the folder exactly as the file system spells it.
test('the @ alias is the canonical path of frontend/src', async () => {
  const { loadConfigFromFile } = await import(new URL('../frontend/node_modules/vite/dist/node/index.js', import.meta.url));
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(frontend, 'vite.config.ts'), frontend, 'silent');
  const alias = loaded.config.resolve.alias['@'];
  assert.equal(alias, realpathSync.native(path.join(frontend, 'src')));
  assert.equal(loaded.config.build.outDir, realpathSync.native(path.join(frontend, '..', 'server', 'dist')));
});
