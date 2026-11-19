import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// The one check for a play's poster link: a catalogue poster for any play, a
// stored poster of the play's own kind, nothing else.
test('play poster links', async () => {
  const {isPlayPoster} = await loadFrontend("export {isPlayPoster} from './src/lib/playPosters';");
  const catalogue = '/api/media/images/7?s=a&e=1&g=b', mum = '/api/activity/history-images/3?s=a', imported = '/api/activity/imported-history-images/4?s=a';
  for (const source of ['mum', 'imported', 'any']) assert.equal(isPlayPoster(catalogue, source), true, source);
  assert.equal(isPlayPoster(mum, 'mum'), true);
  assert.equal(isPlayPoster(mum, 'imported'), false);
  assert.equal(isPlayPoster(imported, 'imported'), true);
  assert.equal(isPlayPoster(imported, 'mum'), false);
  assert.equal(isPlayPoster(mum), true);
  assert.equal(isPlayPoster(imported), true);
  for (const bad of [null, 7, '', 'https://plex.tv/p.jpg', '/api/media/images/7?s=a b', '/api/media/images/7#x', '/library/metadata/1/thumb', '/api/media/collections/images/1?s=a', '/api/media/images/' + 'x'.repeat(2048)]) {
    assert.equal(isPlayPoster(bad), false, String(bad).slice(0, 40));
  }
});
