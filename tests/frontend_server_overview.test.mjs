import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// A server's Overview: one Availability line instead of three "active" rows,
// and a connection label that doesn't call an unchecked server offline.
const load = () => loadFrontend("export * from './src/lib/serverOverview';");

test('server overview wording', async () => {
  const m = await load();
  assert.deepEqual(m.serverAvailability({provider_enabled: true, is_active: true}, 'Jellyfin'), {active: true, text: 'Active'});
  assert.deepEqual(m.serverAvailability({provider_enabled: false, is_active: true}, 'Jellyfin'), {active: false, text: 'Off: Jellyfin is turned off in Media Servers'});
  assert.deepEqual(m.serverAvailability({provider_enabled: true, is_active: false}, 'Jellyfin'), {active: false, text: 'Off: this server is turned off'});
  // Both off: turning the server on alone wouldn't help, so the service is named.
  assert.deepEqual(m.serverAvailability({provider_enabled: false, is_active: false}, 'Plex'), {active: false, text: 'Off: Plex is turned off in Media Servers'});
  assert.equal(m.connectionLabel(null), 'Not checked yet');
  assert.equal(m.connectionLabel(true), 'Online');
  assert.equal(m.connectionLabel(false), 'Offline');
});
