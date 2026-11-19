import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// Play history: the reply is checked strictly, absent types read as zero, and
// times and periods read the way Plex's play history writes them.
const load = () => loadFrontend("export * from './src/lib/playHistoryGraph';");
const reply = extra => ({data: {days: 30, server_id: null, media: 'all', user: null, bucket: 'week',
  buckets: [{start: '2026-10-21', end: '2026-10-27', seconds: {}}, {start: '2026-10-28', end: '2026-11-03', seconds: {movies: 31320, tv: 5040, music: 1680}}],
  totals: {movies: 31320, tv: 5040, music: 1680, photos: 0, other: 0},
  users: [{uuid: '11111111-1111-4111-8111-111111111111', name: 'viewer'}], ...extra}});

test('play history reply', async () => {
  const m = await load();
  const history = m.readPlayHistory(reply(), 30);
  assert.equal(history.bucket, 'week');
  assert.deepEqual(history.buckets[0].seconds, {movies: 0, tv: 0, music: 0, photos: 0, other: 0});
  assert.equal(history.buckets[1].seconds.tv, 5040);
  assert.equal(history.users[0].name, 'viewer');
  const bad = [
    {days: 7}, {bucket: 'year'}, {media: 'books'}, {buckets: []},
    {buckets: [{start: '2026-10-28', end: '2026-10-21', seconds: {}}]},
    {buckets: [{start: '2026-10-21', end: '2026-10-27', seconds: {}}, {start: '2026-10-27', end: '2026-11-02', seconds: {}}]},
    {buckets: [{start: '2026-10-21', end: '2026-10-27', seconds: {books: 1}}]},
    {buckets: [{start: '2026-10-21', end: '2026-10-27', seconds: {movies: -1}}]},
    {totals: {movies: 1, tv: 0, music: 0, photos: 0}},
    {users: [{uuid: 'someone', name: 'x'}]},
  ];
  for (const extra of bad) assert.throws(() => m.readPlayHistory(reply(extra), 30), /Invalid play history/, JSON.stringify(extra));
  assert.throws(() => m.readPlayHistory(null, 30), /Invalid play history/);
});

test('play history wording', async () => {
  const m = await load();
  assert.deepEqual([0, 59, 2160, 34920, 59040, 302400].map(m.playHistoryDuration), ['0s', '59s', '36m', '9.7h', '16.4h', '3.5d']);
  const week = {start: '2026-11-09', end: '2026-11-16'};
  assert.match(m.playHistoryTitle('week', week), /^November 9th - November 16th$/);
  assert.match(m.playHistoryTitle('day', {start: '2026-11-01', end: '2026-11-01'}), /^November 1st$/);
  assert.match(m.playHistoryTitle('day', {start: '2026-11-12', end: '2026-11-12'}), /^November 12th$/);
  assert.match(m.playHistoryTitle('day', {start: '2026-11-23', end: '2026-11-23'}), /^November 23rd$/);
  assert.match(m.playHistoryAxisLabel('week', week), /^Nov 9 - Nov 16$/);
  assert.match(m.playHistoryAxisLabel('month', {start: '2026-11-01', end: '2026-11-19'}), /^Nov 2026$/);
});
