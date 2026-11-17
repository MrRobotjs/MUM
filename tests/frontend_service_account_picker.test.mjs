import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFrontend } from './frontendLoader.mjs';

// Linking a service account from a profile: pick the server, then search its
// unlinked users (ACCOUNT_PAGE_DESIGN.md).
const accounts = [
  { uuid: 'a', service_type: 'plex', server_name: 'Main', external_username: 'AllGas', external_email: 'gas@example.test' },
  { uuid: 'b', service_type: 'jellyfin', server_name: 'Living Room', external_username: 'zed' },
  { uuid: 'c', service_type: 'jellyfin', server_name: 'Living Room', external_username: 'AllBass' },
  { uuid: 'd', service_type: 'emby', server_name: 'Main', external_username: 'other' },
];

test('the link picker groups by server and searches one server at a time', async () => {
  const m = await loadFrontend("export * from './src/lib/serviceAccountPicker';");
  const servers = m.pickerServers(accounts);
  assert.deepEqual(servers.map(s => [s.name, s.serviceType, s.count]), [['Living Room', 'jellyfin', 2], ['Main', 'emby', 1], ['Main', 'plex', 1]], 'same-named servers of different services stay apart');
  const living = servers[0].key, plex = servers[2].key;
  assert.deepEqual(m.pickerAccounts(accounts, living, '').map(a => a.uuid), ['c', 'b'], 'sorted by username, ignoring case');
  assert.deepEqual(m.pickerAccounts(accounts, living, ' allb ').map(a => a.uuid), ['c']);
  assert.deepEqual(m.pickerAccounts(accounts, plex, 'gas@example').map(a => a.uuid), ['a'], 'email matches too');
  assert.deepEqual(m.pickerAccounts(accounts, plex, 'zed'), [], 'other servers never leak into the list');
  assert.deepEqual(m.pickerServers([]), []);
});
