import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SWR shares one cache entry per key. A shared cache key whose fetcher reshapes
// the response must not also be read through useAdminApi, which caches the raw
// response under the same key: whichever fetcher runs first decides the shape
// every reader sees (the Invites page crashed this way on /api/providers).
const source = fileURLToPath(new URL('../frontend/src/', import.meta.url));

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test('raw useAdminApi reads never share a key with a reshaping cache', () => {
  const sources = files(source).map(path => ({ path, text: readFileSync(path, 'utf8') }));
  const sharedKeys = new Set();
  for (const { text } of sources) {
    for (const match of text.matchAll(/export const \w+_CACHE_KEY\s*=\s*'(\/api\/[^']+)'/g)) sharedKeys.add(match[1]);
  }
  assert.ok(sharedKeys.has('/api/providers'), 'expected the shared providers cache key');
  const collisions = [];
  for (const { path, text } of sources) {
    for (const match of text.matchAll(/useAdminApi(?:<[^(]*>)?\(\s*['`]([^'`]+)['`]/g)) {
      const key = `/api${match[1]}`;
      if (sharedKeys.has(key)) collisions.push(`${path.slice(source.length)} reads ${key}`);
    }
  }
  assert.deepEqual(collisions, []);
});
