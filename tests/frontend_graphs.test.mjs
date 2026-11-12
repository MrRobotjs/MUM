import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
const { build } = createRequire(new URL('../frontend/package.json', import.meta.url))('esbuild');
async function load() {
  const result = await build({ stdin: { contents: "export * from './src/lib/graphs';", resolveDir: directory }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${Math.random()}`);
}

test('unrecorded graph datasets are labelled unavailable, never empty history', async () => {
  const { graphEmptyMessage } = await load();
  const fallback = 'No playback history found for this time range.';
  const meta = { unavailable: ['device_preferences', 'playback_health', 'watch_time_activity'] };
  assert.equal(graphEmptyMessage(meta, 'playback_health', fallback), 'This data is not recorded yet.');
  assert.equal(graphEmptyMessage(meta, 'hourly_activity', 'No activity.'), 'No activity.');
  assert.equal(graphEmptyMessage(undefined, 'playback_health', fallback), fallback);
  assert.equal(graphEmptyMessage({ unavailable: 'playback_health' }, 'playback_health', fallback), fallback);
});

test('hourly activity overlay appears only when the server reports it unavailable', async () => {
  const { graphUnavailable } = await load();
  assert.equal(graphUnavailable({ unavailable: ['hourly_activity'] }, 'hourly_activity'), true);
  assert.equal(graphUnavailable({ unavailable: ['playback_health'] }, 'hourly_activity'), false);
  assert.equal(graphUnavailable(undefined, 'hourly_activity'), false);
});
