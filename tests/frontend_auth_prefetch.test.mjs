import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';

const directory = fileURLToPath(new URL('../frontend/', import.meta.url));

// Render AuthProvider once with stubbed React (effects run immediately), a
// stubbed session hook and a spy for the administrator-only provider prefetch.
async function load() {
  
  return loadFrontend("export { AuthProvider } from './src/contexts/AuthContext';",{mock:{filter:/^react(\/jsx-runtime)?$|hooks\/useSession$|cache\/pluginsCache$/,module:path=>(args => {
        if (args.path === 'react') return { contents: 'export const createContext=()=>({Provider:()=>null});export const useContext=()=>null;export const useEffect=f=>f();export const useRef=v=>({current:v});' };
        if (args.path === 'react/jsx-runtime') return { contents: 'export const jsx=()=>null;export const jsxs=()=>null;export const Fragment=null;' };
        if (args.path.endsWith('useSession')) return { contents: 'export const useSession=()=>globalThis.authStub.session;' };
        return { contents: 'export const prefetchPluginConfigCache=()=>{globalThis.authStub.prefetches++;return Promise.resolve(null);};' };
      })({path}).contents}});
}

const user = (admin) => ({ id: 7, uuid: '00000000-0000-4000-8000-000000000007', username: 'carol', user_type: 'local', is_active: true, created_at: '2026-11-05T00:00:00Z', has_admin_access: admin });

test('provider capabilities are prefetched only for administrator sessions', async () => {
  const { AuthProvider } = await load();
  for (const [name, session, expected] of [['ordinary user', { user: user(false), permissions: [] }, 0], ['administrator', { user: user(true), permissions: ['administrator'] }, 1], ['signed out', null, 0]]) {
    globalThis.authStub = { prefetches: 0, session: { session, loading: false, error: undefined, refresh: async () => {} } };
    AuthProvider({ children: null });
    assert.equal(globalThis.authStub.prefetches, expected, name);
  }
});
