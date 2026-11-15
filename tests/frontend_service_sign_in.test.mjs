import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFrontend } from './frontendLoader.mjs';

const loadLib = () => loadFrontend("export * from './src/lib/serviceSignIn'");
const server = (extra = {}) => ({ id: 7, name: 'Living Room', type: 'jellyfin', ...extra });

// render flattens a React element tree into text, calling function components.
const renderer = `export function render(e){if(e==null||e===false||e===true)return '';if(typeof e!=='object')return String(e);if(Array.isArray(e))return e.map(render).join('');if(typeof e.type==='function')return render(e.type(e.props));const p=e.props??{};return '<'+e.type+(p.id?' id='+p.id:'')+(p.disabled?' disabled':'')+'>'+render(p.children)+'</'+e.type+'>';}`;
const uiMock = `export const Card='div',CardContent='div',CardHeader='div',CardTitle='div',CardDescription='div',Input='input',Label='label',Button='button',Checkbox='input',Separator='hr',Alert='div',AlertDescription='div',ResponsiveDialog='div',FontAwesomeIcon='i',Spinner='i',Select='div',SelectContent='div',SelectItem='div',SelectTrigger='div',SelectValue='span',Switch='input';`;

test('sign-in answers are checked before use', async () => {
  const { parseSignInMethods, parseServiceLinks, parseSignInSettings } = await loadLib();
  assert.deepEqual(parseSignInMethods({ service_sign_in: true, plex: true, servers: [server()] }), { serviceSignIn: true, plex: true, servers: [server()] });
  for (const bad of [
    null, { service_sign_in: 'yes', plex: false, servers: [] },
    { service_sign_in: true, plex: false, servers: [server({ type: 'komga' })] },
    { service_sign_in: true, plex: false, servers: [server({ type: 'plex' })] },
    { service_sign_in: true, plex: false, servers: [server(), server()] },
    { service_sign_in: true, plex: false, servers: [server({ id: 0 })] },
    { service_sign_in: false, plex: false, servers: [server()] },
  ]) assert.throws(() => parseSignInMethods(bad), /Unexpected/, JSON.stringify(bad));
  // A linked Plex account signs in with the media server switch off.
  assert.deepEqual(parseSignInMethods({ service_sign_in: false, plex: true, servers: [] }), { serviceSignIn: false, plex: true, servers: [] });
  const link = { service_uuid: '0b0b0b0b-0000-4000-8000-000000000001', server_id: 7, server_name: 'Living Room', server_type: 'jellyfin', username: 'alice', can_unlink: false };
  assert.equal(parseServiceLinks({ links: [link], servers: [], service_sign_in: true }).links[0].canUnlink, false);
  assert.throws(() => parseServiceLinks({ links: [{ ...link, can_unlink: 'no' }], servers: [], service_sign_in: true }), /Unexpected/);
  assert.throws(() => parseServiceLinks({ links: [{ ...link, service_uuid: '../x' }], servers: [], service_sign_in: true }), /Unexpected/);
  assert.deepEqual(parseSignInSettings({ service_sign_in: true, service_sign_in_admins: false, passwordless_accounts: 3, passwordless_admins: 0 }), { serviceSignIn: true, serviceSignInAdmins: false, passwordlessAccounts: 3, passwordlessAdmins: 0 });
  assert.throws(() => parseSignInSettings({ service_sign_in: true, service_sign_in_admins: false, passwordless_accounts: -1, passwordless_admins: 0 }), /Unexpected/);
});

test('a media server sign-in posts to the server sign-in route only', async t => {
  const before = globalThis.fetch, beforeWindow = globalThis.window;
  t.after(() => { globalThis.fetch = before; globalThis.window = beforeWindow; });
  globalThis.window = { location: { origin: 'https://mum.example' }, sessionStorage: { setItem() {} } };
  const calls = [];
  globalThis.fetch = async (request) => {
    calls.push({ url: new URL(request.url).pathname, method: request.method, body: await request.text() });
    return new Response(JSON.stringify({ data: { access_token: 'T'.repeat(43) } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const { serviceSignIn, saveSignInSettings } = await loadLib();
  assert.equal(await serviceSignIn(7, 'alice', 'secret', true), 'T'.repeat(43));
  assert.deepEqual(calls[0], { url: '/api/auth/service', method: 'POST', body: JSON.stringify({ server_id: 7, username: 'alice', password: 'secret', remember: true }) });
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { access_token: 'short' } }), { status: 200 });
  await assert.rejects(serviceSignIn(7, 'alice', 'secret', false), /access token/);
  // Turning the main switch off always turns the administrator switch off.
  globalThis.fetch = async (request) => { calls.push({ body: await request.text() }); return new Response(JSON.stringify({ data: { service_sign_in: false, service_sign_in_admins: false, passwordless_accounts: 0, passwordless_admins: 0 } }), { status: 200 }); };
  await saveSignInSettings(false, true);
  assert.equal(calls.at(-1).body, JSON.stringify({ service_sign_in: false, service_sign_in_admins: false }));
});

async function loginPage() {
  return loadFrontend(`export {default as Login} from './src/pages/LoginPage';`, { mock: { filter: s => s === 'react' || /components\/ui|@fortawesome\/react-fontawesome|lib\/plexSignIn|lib\/serviceSignIn|hooks\/useSignInMethods|config\/pluginMetadata|hooks\/useSession|util\/tokenStore|util\/apiClient|@tanstack\/react-router/.test(s), module: s => {
    if (/components\/ui|@fortawesome\/react-fontawesome/.test(s)) return uiMock;
    if (s === 'react') return `export const useState=v=>[v==='mum'?(globalThis.__login.target??v):v,()=>{}];export const useRef=v=>({current:v});export const useEffect=()=>{};export default {};`;
    if (s.includes('pluginMetadata')) return `export const getServiceIcon=t=>'icon:'+t;export const getServiceMeta=t=>({label:{jellyfin:'Jellyfin',emby:'Emby'}[t]??t});`;
    if (s.includes('useSignInMethods')) return `export const useSignInMethods=()=>globalThis.__login.methods;`;
    if (s.includes('serviceSignIn')) return `export const serviceSignIn=async(id,u,p,r)=>{globalThis.__login.events.push('service:'+id+':'+u+':'+r);return 'fixture'};`;
    if (s.includes('plexSignIn')) return `export const startPlexSignIn=async()=>({});export const checkPlexSignIn=async()=>({});`;
    if (s.includes('useSession')) return `import {getAuthSnapshot} from '@/store/authStore';export async function readFreshSession(c){globalThis.__login.events.push('fresh');c?.(getAuthSnapshot());return {user:{has_admin_access:false}}};export const useSession=()=>({session:null});`;
    if (s.includes('tokenStore')) return `export const setAccessToken=()=>globalThis.__login.events.push('token');`;
    if (s.includes('apiClient')) return `export class ApiError extends Error{};export const requestJson=async(path)=>{globalThis.__login.events.push(path);return {data:{access_token:'fixture'}}};`;
    return `export const useNavigate=()=>p=>globalThis.__login.events.push(p);export const useLocation=()=>({state:{}});export const useSearch=()=>({});`;
  } } });
}

const find = (e, p) => { if (!e || typeof e !== 'object') return null; if (p(e)) return e; for (const c of [e.props?.children].flat(Infinity)) { const f = find(c, p); if (f) return f; } return null; };

test('the login page sends a server choice to that server and a MUM choice to the password route', async () => {
  const m = await loginPage();
  const methods = { serviceSignIn: true, plex: false, servers: [{ id: 7, name: 'Living Room', type: 'jellyfin' }] };
  for (const [target, first] of [['7', 'service:7::false'], ['mum', '/api/auth/login'], ['9', '/api/auth/login']]) {
    globalThis.__login = { events: [], methods, target };
    await find(m.Login(), e => e.type === 'form').props.onSubmit({ preventDefault() {} });
    assert.deepEqual(globalThis.__login.events.slice(0, 3), [first, 'token', 'fresh'], target);
  }
  delete globalThis.__login;
});

test('the login page names each server with its icon, nickname and type', async () => {
  const m = await loginPage();
  const text = e => e == null || typeof e === 'boolean' ? '' : typeof e !== 'object' ? String(e) : Array.isArray(e) ? e.map(text).join('') : text(e.props?.children);
  globalThis.__login = { events: [], methods: { serviceSignIn: true, plex: false, servers: [{ id: 7, name: 'Jelly++', type: 'jellyfin' }, { id: 8, name: 'Den', type: 'emby' }] } };
  const page = m.Login();
  assert.equal(text(find(page, e => e.props?.htmlFor === 'sign-in-target')), 'Sign in using');
  const option = id => text(find(page, e => e.props?.value === id && e.type === 'div' && !e.props?.onValueChange));
  assert.equal(option('7'), 'icon:jellyfinJelly++ (Jellyfin)');
  assert.equal(option('8'), 'icon:embyDen (Emby)');
  assert.equal(option('mum'), 'MUM account');
  delete globalThis.__login;
});

test('the login page offers only the sign-in methods that are on', async () => {
  const m = await loginPage();
  const plexButton = page => find(page, e => e.props?.onClick?.name === 'handlePlexSSO');
  const picker = page => find(page, e => e.props?.id === 'sign-in-target');
  const field = (page, id) => find(page, e => e.props?.id === id);
  const option = (page, value) => find(page, e => e.props?.value === value && !e.props?.onValueChange);
  globalThis.__login = { events: [], methods: { serviceSignIn: false, plex: false, servers: [] } };
  let page = m.Login();
  assert.equal(plexButton(page), null);
  assert.equal(picker(page), null);
  // Plex is a choice in the picker; its button shows only once it is chosen.
  globalThis.__login.methods = { serviceSignIn: true, plex: true, servers: [{ id: 7, name: 'Living Room', type: 'jellyfin' }] };
  page = m.Login();
  assert.ok(option(page, 'plex'));
  assert.equal(plexButton(page), null, 'Plex button shown before Plex is chosen');
  assert.ok(field(page, 'username') && field(page, 'password'));
  globalThis.__login.target = 'plex';
  page = m.Login();
  assert.ok(plexButton(page));
  assert.equal(field(page, 'username'), null, 'Plex never asks for a password here');
  assert.equal(field(page, 'password'), null);
  assert.equal(find(page, e => e.props?.type === 'submit'), null);
  assert.ok(field(page, 'remember'), 'remember this device applies to Plex too');
  // A linked Plex account works with the media server switch off.
  globalThis.__login = { events: [], target: 'plex', methods: { serviceSignIn: false, plex: true, servers: [] } };
  page = m.Login();
  assert.ok(picker(page) && plexButton(page));
  globalThis.__login = { events: [], target: 'plex', methods: { serviceSignIn: true, plex: false, servers: [{ id: 7, name: 'Living Room', type: 'jellyfin' }] } };
  page = m.Login();
  assert.equal(option(page, 'plex'), null);
  assert.equal(plexButton(page), null, 'no Plex button while Plex is off');
  assert.ok(field(page, 'password'));
  delete globalThis.__login;
});

test('the settings explain the administrator choice and warn before locking accounts out', async () => {
  const m = await loadFrontend(`export {SignInSettingsFields} from './src/components/settings/SignInSettingsCard';${renderer}`, { mock: { filter: s => /components\/ui|ui\/|@fortawesome\/react-fontawesome|contexts|lib\/serviceSignIn/.test(s), module: s => /contexts/.test(s) ? `export const useAlerts=()=>({});` : /serviceSignIn/.test(s) ? `export const getSignInSettings=async()=>({});export const saveSignInSettings=async()=>({});` : uiMock } });
  const saved = { serviceSignIn: true, serviceSignInAdmins: true, passwordlessAccounts: 3, passwordlessAdmins: 1 };
  const html = (value) => m.render(m.SignInSettingsFields({ value, saved, disabled: false, onChange() {} }));
  const on = html({ serviceSignIn: true, admins: true });
  assert.match(on, /Off \(recommended\)/);
  assert.match(on, /controls that media server/);
  assert.match(on, /owner always signs in with the MUM password/);
  assert.doesNotMatch(on, /will not be able to sign in/);
  assert.match(html({ serviceSignIn: false, admins: false }), /3 accounts have no MUM password/);
  assert.match(html({ serviceSignIn: true, admins: false }), /1 administrator has no MUM password/);
  assert.match(html({ serviceSignIn: false, admins: false }), /<input id=service_sign_in_admins disabled>/);
});

test('linked accounts are offered for unlinking only while another sign-in remains', async () => {
  const m = await loadFrontend(`export {ServiceLinksList} from './src/components/users/ServiceLinksCard';${renderer}`, { mock: { filter: s => /components\/ui|ui\/|contexts|lib\/serviceSignIn|util\/apiClient/.test(s), module: s => /contexts/.test(s) ? `export const useAlerts=()=>({});` : /serviceSignIn/.test(s) ? `export const getServiceLinks=async()=>({});export const linkServiceAccount=async()=>{};export const unlinkServiceAccount=async()=>{};` : /apiClient/.test(s) ? `export class ApiError extends Error{};` : uiMock } });
  const link = (canUnlink, name) => ({ serviceUuid: name + '-0000-4000-8000-000000000000', serverId: 7, serverName: name, serverType: 'jellyfin', username: 'alice', canUnlink });
  const only = m.render(m.ServiceLinksList({ links: [link(false, 'Living Room')], busy: false, onUnlink() {} }));
  assert.doesNotMatch(only, /<button>Unlink/);
  assert.match(only, /Only way to sign in/);
  const two = m.render(m.ServiceLinksList({ links: [link(true, 'Living Room'), link(true, 'Bedroom')], busy: false, onUnlink() {} }));
  assert.equal(two.match(/<button>Unlink<\/button>/g)?.length, 2);
  assert.match(m.render(m.ServiceLinksList({ links: [], busy: false, onUnlink() {} })), /No media server accounts/);
});
