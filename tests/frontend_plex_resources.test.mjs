import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

test('Plex resource statistics shaping', async t => {
  const before = { fetch: globalThis.fetch, window: globalThis.window };
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = { location: { origin: 'http://mum.test' } };
  const m = await loadFrontend("export * from './src/lib/plexResources';");
  const sample = (at, bytes, lan, account = '1') => ({ at, bytes, lan, account_id: account, device_id: '7' });

  await t.test('real-time bandwidth becomes a rate over the gap to the previous bin, remote and local apart', () => {
    const points = m.bandwidthSeries([
      sample('2026-11-13T10:00:02Z', 2000, false),
      sample('2026-11-13T10:00:00Z', 1000, true),
      sample('2026-11-13T10:00:02Z', 500, true, '2'),
    ], 'seconds', null);
    assert.deepEqual(points, [
      { at: '2026-11-13T10:00:00Z', remote: 0, local: 4 },
      { at: '2026-11-13T10:00:02Z', remote: 8, local: 2 },
    ]);
    // One account's share only.
    assert.deepEqual(m.bandwidthSeries([sample('2026-11-13T10:00:00Z', 1000, true), sample('2026-11-13T10:00:00Z', 500, true, '2')], 'seconds', '2'), [{ at: '2026-11-13T10:00:00Z', remote: 0, local: 4 }]);
  });

  await t.test('longer bins keep the bytes sent in each bin', () => {
    assert.deepEqual(m.bandwidthSeries([sample('2026-11-12T00:00:00Z', 5e9, false), sample('2026-11-12T00:00:00Z', 1e9, true)], 'days', null), [{ at: '2026-11-12T00:00:00Z', remote: 5e9, local: 1e9 }]);
    assert.equal(m.formatBytes(5e9), '5.0 GB');
    assert.equal(m.formatRate(117), '117 Kbps');
    assert.equal(m.formatRate(2500), '2.5 Mbps');
  });

  await t.test('each period reads from its start, and quiet hours or days show as empty bars', () => {
    const now = Date.parse('2026-11-13T12:30:00Z');
    const range = (value) => m.BANDWIDTH_RANGES.find((r) => r.value === value);
    assert.deepEqual(m.BANDWIDTH_RANGES.map((r) => r.label), ['Real Time', 'Last 12 Hours', 'Last 24 Hours', 'Last 7 Days', 'Last 30 Days', 'Last 90 Days', 'Last Year', 'All Time']);
    assert.equal(m.rangeSince(range('12h'), now), '2026-11-13T00:30:00Z');
    assert.equal(m.rangeSince(range('realtime'), now), null);
    assert.equal(m.rangeSince(range('all'), now), null);
    const bars = m.bandwidthBars([
      sample('2026-11-13T09:00:00Z', 4000, false),
      sample('2026-11-13T11:00:00Z', 1000, true),
      sample('2026-11-12T20:00:00Z', 9999, false), // before the 12 hours
    ], range('12h'), null, now);
    assert.equal(bars[0].at, '2026-11-13T01:00:00.000Z');
    assert.equal(bars.length, 12);
    assert.deepEqual(bars.find((b) => b.at === '2026-11-13T09:00:00Z'), { at: '2026-11-13T09:00:00Z', remote: 4000, local: 0 });
    assert.deepEqual(bars.find((b) => b.at === '2026-11-13T10:00:00.000Z'), { at: '2026-11-13T10:00:00.000Z', remote: 0, local: 0 });
    // Months are shown as Plex reports them.
    assert.equal(m.bandwidthBars([sample('2025-01-01T00:00:00Z', 1, false), sample('2026-01-01T00:00:00Z', 2, true)], range('all'), null, now).length, 2);
  });

  await t.test('CPU and memory series keep unknown readings as gaps', () => {
    const readings = [
      { at: '2026-11-13T10:00:02Z', host_cpu: 70, process_cpu: 55, host_memory: 42, process_memory: null },
      { at: '2026-11-13T10:00:00Z', host_cpu: 12.5, process_cpu: 3, host_memory: 41, process_memory: 2.5 },
    ];
    assert.deepEqual(m.resourceSeries(readings, 'cpu'), [{ at: '2026-11-13T10:00:00Z', system: 12.5, plex: 3 }, { at: '2026-11-13T10:00:02Z', system: 70, plex: 55 }]);
    assert.deepEqual(m.resourceSeries(readings, 'memory')[1], { at: '2026-11-13T10:00:02Z', system: 42, plex: null });
  });

  await t.test('answers for another server or with bad samples are not shown', async () => {
    globalThis.fetch = async () => Response.json({ data: { server_id: 4, samples: [] } });
    await assert.rejects(m.fetchResources(3), /Unexpected/);
    globalThis.fetch = async () => Response.json({ data: { server_id: 3, samples: [{ at: 'x', host_cpu: 1 }, { at: '2026-11-13T10:00:00Z', host_cpu: -1, process_cpu: 'high' }] } });
    assert.deepEqual(await m.fetchResources(3), [{ at: '2026-11-13T10:00:00Z', host_cpu: null, process_cpu: null, host_memory: null, process_memory: null }]);
  });
});
