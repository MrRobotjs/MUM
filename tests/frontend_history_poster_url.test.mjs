import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

test('history poster keeps a valid signature only for the same image and session', async () => {
  const {stableHistoryPosterURL} = await loadFrontend("export {stableHistoryPosterURL} from './src/lib/historyPosterURL';");
  const old = '/api/media/images/42?s=session&e=2000&g=old';
  const renewed = '/api/media/images/42?s=session&e=2400&g=new';
  assert.equal(stableHistoryPosterURL(old, renewed, 1000), old);
  assert.equal(stableHistoryPosterURL(old, renewed, 1980), renewed);
  assert.equal(stableHistoryPosterURL(old, renewed.replace('/42?', '/43?'), 1000), renewed.replace('/42?', '/43?'));
  assert.equal(stableHistoryPosterURL(old, renewed.replace('s=session', 's=other'), 1000), renewed.replace('s=session', 's=other'));
  assert.equal(stableHistoryPosterURL(old, undefined, 1000), undefined);
});
