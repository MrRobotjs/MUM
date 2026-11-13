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
