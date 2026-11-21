import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFrontend} from './frontendLoader.mjs';

test('device sign-out accepts only confirmed counts and never replays a mutation', async () => {
  globalThis.sessionReply = { data: { ended: 2 } };
  globalThis.sessionRequests = [];
  const mod = await loadFrontend("export * from './src/lib/accountSessions';", {mock:{filter:s=>s.endsWith("util/apiClient"),module:()=>`export async function requestJson(url, init) { globalThis.sessionRequests.push({url,init}); return globalThis.sessionReply; }`}});
  assert.equal(await mod.signOutOtherSessions(), 2);
  assert.equal(globalThis.sessionRequests[0].init.retryAuthentication, false);
  assert.equal(await mod.signOutUserEverywhere('a/b'), 2);
  assert.equal(globalThis.sessionRequests[1].url, '/api/users/a%2Fb/sessions/sign-out');
  globalThis.sessionReply = {data:{ended:'2'}};
  await assert.rejects(mod.signOutOtherSessions(), /Invalid sign-out confirmation/);
  await assert.rejects(mod.endAccountSession('session'), /Invalid sign-out confirmation/);
  assert.equal(globalThis.sessionRequests.length, 4);
  globalThis.sessionReply = { data: { ended: 2, signed_out_here: true } };
  await mod.signOutAllSessions();
  assert.equal(globalThis.sessionRequests.at(-1).url, '/api/account/sessions/sign-out-all');
  assert.equal(globalThis.sessionRequests.at(-1).init.retryAuthentication, false);
  globalThis.sessionReply = { data: { ended: 2, signed_out_here: false } };
  await assert.rejects(mod.signOutAllSessions(), /Invalid sign-out confirmation/);
  delete globalThis.sessionReply; delete globalThis.sessionRequests;
});

test('sign-out confirmation remains bound to its account and successful revocation clears auth after unmount', async t => {
  const old = globalThis.__sessionsHarness;
  t.after(() => { globalThis.__sessionsHarness = old; });
  globalThis.__sessionsHarness = {effects: [], calls: 0, resolve: null};
  const mod = await loadFrontend("export * from './src/components/users/AccountSessionsCard'; export * from './src/store/authStore';", {mock:{
    filter: s => s === 'react' || /ui\/|common\/CardActions|contexts\/AlertContext|hooks\/useAccountDisplay|lib\/accountSessions|AccountSettings|@fortawesome\/react-fontawesome|@tanstack\/react-router/.test(s),
    module: s => {
      if (s === 'react') return `export const useState=v=>[v,()=>{}], useRef=v=>({current:v}), useEffect=f=>globalThis.__sessionsHarness.effects.push(f), useCallback=f=>f, useSyncExternalStore=(sub,get)=>get();`;
      if (s.includes('accountSessions')) return `export const describeDevice=()=>'',describeSignIn=()=>'',fetchAccountSessions=async()=>[],endAccountSession=async()=>({}),signOutOtherSessions=async()=>0,signOutAllSessions=()=>{globalThis.__sessionsHarness.calls++;return new Promise(resolve=>globalThis.__sessionsHarness.resolve=resolve)};`;
      if (s.includes('AlertContext')) return `export const useAlerts=()=>({success(){},error(){}});`;
      if (s.includes('useAccountDisplay')) return `export const useAccountDisplay=()=>({formatRelative:()=>'',formatTimestamp:()=>''});`;
      if (s.includes('@tanstack/react-router')) return `export const useNavigate=()=>()=>{};`;
      if (s.includes('@fortawesome/react-fontawesome')) return `export const FontAwesomeIcon='i';`;
      if (s.includes('AccountSettings')) return `export const ConfirmAction=function ConfirmAction(){},SettingHeader='header';`;
      return `export const Card='div',CardContent='div',Button='button',Spinner='i',CardActions='div';`;
    }
  }});
  const nodes = e => !e || typeof e !== 'object' ? [] : [e,...[e.props?.children].flat(Infinity).flatMap(nodes)];
  mod.setAccessToken('account-a');
  const tree=nodes(mod.AccountSessionsCard());
  const cleanup=globalThis.__sessionsHarness.effects.map(fn=>fn()).filter(fn=>typeof fn==='function');
  const open=tree.find(e=>e.type==='button' && e.props?.children==='Sign out everywhere');
  const confirm=tree.find(e=>e.type?.name==='ConfirmAction' && e.props?.title==='Sign out everywhere?');
  open.props.onClick(); mod.setAccessToken('account-b'); confirm.props.onConfirm();
  assert.equal(globalThis.__sessionsHarness.calls,0);
  open.props.onClick(); confirm.props.onConfirm();
  assert.equal(globalThis.__sessionsHarness.calls,1);
  cleanup.forEach(fn=>fn()); globalThis.__sessionsHarness.resolve();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(mod.getAccessToken(),null);
});
