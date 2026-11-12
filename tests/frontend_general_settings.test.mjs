import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
const { build } = createRequire(new URL('../frontend/package.json', import.meta.url))('esbuild');
async function load() {
  const result = await build({ stdin: { contents: "export * from './src/lib/generalSettings';", resolveDir: directory }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${Math.random()}`);
}

test('general settings save sends only the editable application fields', async () => {
  const { generalSettingsPayload } = await load();
  const form = { app_name: 'Family Media', app_base_url: 'https://media.example.test', app_local_url: '', jwt_cookie_secure: true, jwt_access_token_expires_minutes: 60, jwt_refresh_token_expires_days: 30, api_timeout_seconds: 9, enable_navbar_stream_badge: true, session_monitoring_interval: 5 };
  assert.deepEqual(generalSettingsPayload(form), { app_name: 'Family Media', app_base_url: 'https://media.example.test', app_local_url: '' });
});
