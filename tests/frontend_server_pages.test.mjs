import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// A server's own pages in the sidebar, in order, for its type: History for
// the servers with play history (recorded or imported), Graphs for the servers
// MUM records plays from, Resources for Plex.
const load = () => loadFrontend("export {serverPagesFor} from './src/components/layout/NavServers';");

test('server sidebar pages', async () => {
  const m = await load();
  const titles = type => m.serverPagesFor(type).map(p => p.title);
  assert.deepEqual(titles('plex'), ['Overview', 'Users', 'Libraries', 'History', 'Graphs', 'Resources']);
  assert.deepEqual(titles('jellyfin'), ['Overview', 'Users', 'Libraries', 'History', 'Graphs']);
  assert.deepEqual(titles('emby'), ['Overview', 'Users', 'Libraries', 'History', 'Graphs']);
  assert.deepEqual(titles('audiobookshelf'), ['Overview', 'Users', 'Libraries', 'History']);
  assert.deepEqual(titles('kavita'), ['Overview', 'Users', 'Libraries']);
  const graphs = m.serverPagesFor('plex').find(p => p.title === 'Graphs');
  assert.equal(graphs.to, '/admin/servers/$serverId/graphs');
  assert.equal(graphs.suffix, '/graphs');
  const history = m.serverPagesFor('audiobookshelf').find(p => p.title === 'History');
  assert.equal(history.to, '/admin/servers/$serverId/history');
});
