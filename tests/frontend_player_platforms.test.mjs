import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFrontend } from './frontendLoader.mjs';

// The Players card's logos: Tautulli's platform keywords, then the app name for
// services that report no platform.
const load = () => loadFrontend("export * from './src/lib/playerPlatforms';");

test('player logos', async () => {
  const { playerLogo } = await load();
  const name = (platform, client = '') => playerLogo(platform, client).name;
  // Plex platforms, as Tautulli maps them.
  assert.equal(name('Android'), 'Android');
  assert.equal(name('tvOS'), 'Apple TV');
  assert.equal(name('Roku'), 'Roku');
  assert.equal(name('Tizen'), 'Samsung');
  assert.equal(name('webOS'), 'LG');
  assert.equal(name('iPhone'), 'iOS');
  assert.equal(name('Microsoft Edge'), 'Edge');
  assert.equal(name('osx'), 'macOS');
  assert.equal(name('Konvergo'), 'Plex');
  assert.equal(name('Mystery 4'), 'PlayStation');
  // Longer keywords win: reverse alphabetical order.
  assert.equal(name('Windows Phone'), 'Windows Phone');
  assert.equal(name('Windows'), 'Windows');
  assert.equal(name('Chromecast'), 'Chromecast');
  assert.equal(name('Chrome'), 'Chrome');
  // The platform comes first; the app name only when the platform says nothing.
  assert.equal(name('Chrome', 'Plex for Android'), 'Chrome');
  assert.equal(name('Something new', 'Plex for Android'), 'Android');
  // Jellyfin and Emby report no platform.
  assert.equal(name(null, 'Jellyfin Android TV'), 'Android');
  assert.equal(name(null, 'Emby for iOS'), 'iOS');
  assert.equal(name(null, 'Infuse'), 'iOS');
  assert.equal(name(null, 'Jellyfin for Fire TV'), 'Fire TV');
  // Anything else gets the neutral logo.
  const other = playerLogo(null, 'Jellyfin Web');
  assert.equal(other.name, 'Other');
  assert.equal(other.color, '#64748b');
  // Brand colour and a Font Awesome icon.
  const android = playerLogo('Android', '');
  assert.equal(android.color, '#3ddc84');
  assert.equal(android.icon.iconName, 'android');
  assert.equal(playerLogo('Roku', '').icon.iconName, 'tv');
});
