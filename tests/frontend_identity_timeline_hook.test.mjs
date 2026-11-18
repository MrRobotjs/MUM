import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// The History tab keeps the same person's previous page on screen while a
// filter, records, server or paging change loads, instead of collapsing to a
// loading line; another person's page is never shown.
const mocks = {
  filter: /^(react|swr)$|contexts\/AuthContext$|lib\/identityTimeline$/,
  module: p => p === 'react' ? 'export const useSyncExternalStore=(s,r)=>r();export const useEffect=()=>{};export const useState=v=>[v,()=>{}];'
    : p === 'swr' ? 'export default (key,fetcher,options)=>{globalThis.timelineHarness={key,fetcher,options};return globalThis.timelineState;};'
    : /AuthContext$/.test(p) ? "export const useAuth=()=>({user:{uuid:'admin'},isAdministrator:true});"
    : 'export const fetchIdentityTimeline=async(...args)=>({args});',
};
const load = () => loadFrontend("export {useIdentityTimeline} from './src/hooks/useIdentityTimeline';export {setAccessToken} from './src/store/authStore';", {mock: mocks});
const view = (types = []) => ({records: 'all', types, methods: []});
const page = (target = 'person') => ({actor_uuid: 'admin', target_uuid: target, records: 'all', items: []});

test('identity timeline keeps the previous page while the next loads', async t => {
  const m = await load();
  m.setAccessToken('session');
  t.after(() => { delete globalThis.timelineState; delete globalThis.timelineHarness; });

  await t.test('keeps previous data and tags each reply with its request', async () => {
    globalThis.timelineState = {isLoading: true, mutate: async () => {}};
    m.useIdentityTimeline('person', undefined, 'all', view(['movie']));
    const {key, fetcher, options} = globalThis.timelineHarness;
    assert.equal(options.keepPreviousData, true);
    const reply = await fetcher(key);
    assert.equal(reply.tag, JSON.stringify(key));
    assert.equal(reply.page.args[1], 'person');
    assert.deepEqual(reply.page.args[3].filters.types, ['movie']);
  });

  await t.test('a reply for the current view is not pending', () => {
    globalThis.timelineState = {isLoading: false, mutate: async () => {}};
    m.useIdentityTimeline('person', undefined, 'all', view(['movie']));
    globalThis.timelineState.data = {tag: JSON.stringify(globalThis.timelineHarness.key), page: page()};
    const result = m.useIdentityTimeline('person', undefined, 'all', view(['movie']));
    assert.equal(result.page, globalThis.timelineState.data.page);
    assert.equal(result.pending, false);
    assert.equal(result.loading, false);
  });

  await t.test('an earlier reply for the same person stays on screen as pending', () => {
    m.useIdentityTimeline('person', undefined, 'all', view());
    const earlier = {tag: JSON.stringify(globalThis.timelineHarness.key), page: page()};
    globalThis.timelineState = {isLoading: true, data: earlier, mutate: async () => {}};
    const result = m.useIdentityTimeline('person', undefined, 'all', view(['movie']));
    assert.equal(result.page, earlier.page);
    assert.equal(result.pending, true);
    assert.equal(result.loading, false);
  });

  await t.test('another person’s reply is never shown', () => {
    globalThis.timelineState = {isLoading: true, data: {tag: 'x', page: page('someone-else')}, mutate: async () => {}};
    const result = m.useIdentityTimeline('person', undefined, 'all', view());
    assert.equal(result.page, undefined);
    assert.equal(result.pending, false);
    assert.equal(result.loading, true);
  });

  await t.test('an error hides the page', () => {
    globalThis.timelineState = {isLoading: false, error: new Error('down'), data: {tag: 'x', page: page()}, mutate: async () => {}};
    const result = m.useIdentityTimeline('person', undefined, 'all', view());
    assert.equal(result.page, undefined);
    assert.equal(result.loading, false);
    assert.equal(result.error.message, 'down');
  });
});
