import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// Period names in the Activity section's and the Graphs page's period pickers.
test('period labels', async () => {
  const m = await loadFrontend("export {periodLabel} from './src/components/common/PeriodPicker';");
  assert.deepEqual([0, 1, 7, 14, 30, 90, 180, 365, 400].map(m.periodLabel),
    ['All time', 'Last 24 hours', 'Last 7 days', 'Last 14 days', 'Last 30 days', 'Last 90 days', 'Last 6 months', 'Last year', 'Last 400 days']);
});
