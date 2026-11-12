import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';

const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
async function load() {
  
  return loadFrontend("export * from './src/lib/generalSettings';");
}

test('general settings save sends only the editable application fields', async () => {
  const { generalSettingsPayload } = await load();
  const form = { app_name: 'Family Media', app_base_url: 'https://media.example.test', app_local_url: '', jwt_cookie_secure: true, jwt_access_token_expires_minutes: 60, jwt_refresh_token_expires_days: 30, api_timeout_seconds: 9, enable_navbar_stream_badge: true, session_monitoring_interval: 5 };
  assert.deepEqual(generalSettingsPayload(form), { app_name: 'Family Media', app_base_url: 'https://media.example.test', app_local_url: '' });
});
