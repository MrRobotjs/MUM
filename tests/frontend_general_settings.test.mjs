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
  const form = { app_name: 'Family Media', public_address: ' https://media.example.test ', jwt_cookie_secure: true, jwt_access_token_expires_minutes: 60, jwt_refresh_token_expires_days: 30, api_timeout_seconds: 9, enable_navbar_stream_badge: true, session_monitoring_interval: 5 };
  assert.deepEqual(generalSettingsPayload(form), { app_name: 'Family Media', public_address: 'https://media.example.test' });
});

// Where an address can be reached from decides the warnings on invite links
// and on the Public Address field.
test('public address reach and warnings', async () => {
  const m = await loadFrontend("export * from './src/lib/publicAddress';");
  const reach = {
    'http://localhost:5699': 'local', 'http://127.0.0.1:5699': 'local', 'http://192.168.1.10:5699': 'local', 'http://10.0.0.5': 'local',
    'http://172.20.1.1': 'local', 'http://100.101.1.2': 'local', 'http://mum.local': 'local', 'http://nas': 'local', 'http://[::1]:5699': 'local',
    'http://[fd12::1]': 'local', 'http://203.0.113.7:5699': 'ip', 'http://[2001:db8::1]': 'ip', 'https://mum.example.com': 'domain', 'http://172.32.0.1': 'ip',
  };
  for (const [address, want] of Object.entries(reach)) assert.equal(m.addressReach(address), want, address);
  for (const bad of ['', 'mum.example.com', 'ftp://example.com', 'not a url']) assert.equal(m.addressReach(bad), null, bad);
  assert.match(m.inviteLinkWarning('http://192.168.1.10:5699/invite/abc'), /only works on your own network/);
  assert.match(m.inviteLinkWarning('http://203.0.113.7:5699/invite/abc'), /IP address/);
  assert.equal(m.inviteLinkWarning('https://mum.example.com/invite/abc'), null);
  assert.deepEqual(m.publicAddressNotes(''), []);
  assert.deepEqual(m.publicAddressNotes('https://mum.example.com'), []);
  assert.match(m.publicAddressNotes('http://mum.example.com').join(' '), /https:\/\//);
  assert.match(m.publicAddressNotes('https://example.com/mum').join(' '), /without a path/);
  assert.match(m.publicAddressNotes('http://192.168.1.10:5699').join(' '), /your own network/);
  const ip = m.publicAddressNotes('http://203.0.113.7').join(' ');
  assert.match(ip, /IP address/);
  assert.match(ip, /https:\/\//);
  assert.match(m.publicAddressNotes('mum.example.com').join(' '), /full address/);
});
