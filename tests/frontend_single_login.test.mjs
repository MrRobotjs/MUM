import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFrontend} from './frontendLoader.mjs';
test('both guards use ordered current-session decisions and canonical redirects',async()=>{
 const m=await loadFrontend(`export {default as Admin} from './src/router/AdminGuard'; export {default as Signed} from './src/router/SignedInGuard'; export function render(e){if(e==null)return '';if(typeof e!=='object')return String(e);if(typeof e.type==='function')return render(e.type(e.props));return Object.entries(e.props??{}).map(([k,v])=>k==='children'?[v].flat(Infinity).map(render).join(''):k+'="'+v+'"').join(' ');}`,{mock:{filter:/contexts\/AuthContext|@tanstack\/react-router/,module:s=>s.includes('AuthContext')?`export const useAuth=()=>globalThis.__guardAuth;`:`import React from 'react'; export const useLocation=()=>{const p=globalThis.__guardPath??'/admin/users';return {pathname:p,href:p+'?x=1#z'}};export const Navigate=p=>React.createElement('i',{'data-to':p.to,'data-from':p.state?.from});export const Outlet=()=>null;`}});
 for(const Guard of [m.Admin,m.Signed]){
 globalThis.__guardAuth={loading:false,session:{user:{}},hasAdminAccess:false};
 assert.match(m.render(Guard({children:'yes'})),Guard===m.Admin?/data-to="\/home"/:/yes/);
 // Once navigation home has begun the guard renders again with its route still
 // matched; redirecting again would navigate on every render (a hung tab).
 if(Guard===m.Admin){globalThis.__guardPath='/home';assert.equal(m.render(Guard({children:'yes'})),'');delete globalThis.__guardPath;}
 globalThis.__guardAuth={loading:false,session:null,error:{status:503,message:'offline'}};assert.match(m.render(Guard({})),/Unable to load your session/);
 globalThis.__guardAuth={loading:false,session:null,error:{status:401}};assert.match(m.render(Guard({})),/data-to="\/login"/);
 }
 delete globalThis.__guardAuth;delete globalThis.__guardPath;
});
test('real TanStack tree keeps shared pages and removes split login routes',async()=>{
 globalThis.self=globalThis; globalThis.window={addEventListener(){},removeEventListener(){},scrollTo(){}};
 const m=await loadFrontend(`export {default as AppRouter} from './src/router/AppRouter';`,{mock:{filter:/pages\/|\.\/AdminGuard$|\.\/SignedInGuard$|\.\/AppShell$|^@tanstack\/history$/,module:s=>s==='@tanstack/history'?`export * from '${new URL('../frontend/node_modules/@tanstack/history/dist/esm/index.js',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')}'; export {createMemoryHistory as createBrowserHistory} from '${new URL('../frontend/node_modules/@tanstack/history/dist/esm/index.js',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')}';`:`export default function Stub(){return null}; export const EpisodeDetailPage=Stub; export const AdminSettingsPluginsServerAddPage=Stub;export const AdminSettingsPluginsServerEditPage=Stub;`}});
 const router=m.AppRouter().props.router;
 for(const path of ['/login','/home','/account','/admin/users','/admin/dashboard'])assert.equal(router.matchRoutes(path).at(-1).pathname.replace(/\/$/,''),path);
 for(const path of ['/admin/login','/admin/home','/admin/account','/user/dashboard'])assert.equal(router.matchRoutes(path).at(-1).routeId,path.startsWith('/admin/')?'/admin/$':'/$');
 const account=router.matchRoutes('/account',{tab:'credentials'}).at(-1);assert.equal(account.search.tab,'credentials');
 for(const tab of ['overview','credentials','linked-accounts','preferences'])assert.equal(router.matchRoutes('/account',{tab}).at(-1).search.tab,tab);
 const returned=router.buildLocation({href:'/account?tab=credentials#security'});assert.equal(returned.pathname,'/account');assert.equal(returned.search.tab,'credentials');assert.equal(returned.hash,'security');
 router.history.destroy();delete globalThis.window;delete globalThis.self;
});


test('password and Plex sign-in wait for fresh authority and fails closed on stale session',async()=>{
 globalThis.__login={events:[],admin:false,reject:false};
 const m=await loadFrontend(`export {default as Login} from './src/pages/LoginPage';`,{mock:{filter:s=>s==='react'||/components\/ui|@fortawesome\/react-fontawesome|lib\/plexSignIn|hooks\/useSignInMethods|config\/pluginMetadata|hooks\/useSession|util\/tokenStore|util\/apiClient|@tanstack\/react-router/.test(s),module:s=>{
 if(/components\/ui|@fortawesome\/react-fontawesome/.test(s))return `export const Card='div',CardContent='div',CardHeader='div',CardTitle='div',CardDescription='div',Input='input',Label='label',Button='button',Checkbox='input',Separator='hr',Alert='div',AlertDescription='div',ResponsiveDialog='div',FontAwesomeIcon='i',Spinner='i',Select='div',SelectContent='div',SelectItem='div',SelectTrigger='div',SelectValue='span';`;
 if(s==='react')return `export const useState=v=>[v==='mum'?'plex':v,()=>{}];export const useRef=v=>({current:v});export const useEffect=()=>{}; export default {};`;
 if(s.includes('pluginMetadata'))return `export const getServiceIcon=()=>null;export const getServiceMeta=t=>({label:t});`;
 if(s.includes('useSignInMethods'))return `export const useSignInMethods=()=>({serviceSignIn:true,plex:true,servers:[]});`;
 if(s.includes('plexSignIn'))return `export const startPlexSignIn=async()=>({id:'fixture',authorizationUrl:'https://fixture.invalid',expiresAt:new Date(Date.now()+60000).toISOString()});export const checkPlexSignIn=async()=>({status:'signed_in',accessToken:'fixture'});`;
 if(s.includes('useSession'))return `import {getAuthSnapshot} from '@/store/authStore';export async function readFreshSession(checkpoint){globalThis.__login.events.push('fresh');if(globalThis.__login.reject)throw new Error('account changed');checkpoint?.(getAuthSnapshot());return {user:{has_admin_access:globalThis.__login.admin}}};export const useSession=()=>({session:null});`;
 if(s.includes('tokenStore'))return `export const setAccessToken=()=>globalThis.__login.events.push('token');`;
 if(s.includes('apiClient'))return `export class ApiError extends Error{};export const requestJson=async()=>{globalThis.__login.events.push('login');return {data:{access_token:'fixture'}}};`;
 return `export const useNavigate=()=>p=>globalThis.__login.events.push(p);export const useLocation=()=>({state:{}});export const useSearch=()=>({next:globalThis.__login.next??'/admin/users?x=1#z'});`;
 }}});
 const findForm=e=>{if(!e||typeof e!=='object')return null;if(e.type==='form')return e;for(const c of [e.props?.children].flat(Infinity)){const f=findForm(c);if(f)return f}return null};
 for(const [admin,reject,want] of [[false,false,'/home'],[true,false,'/admin/users?x=1#z'],[true,true,null]]){
 globalThis.__login={events:[],admin,reject};await findForm(m.Login()).props.onSubmit({preventDefault(){}});
 assert.deepEqual(globalThis.__login.events.slice(0,3),['login','token','fresh']);
 assert.equal(globalThis.__login.events[3]?.href,want??undefined);
 }
 const findPlex=e=>{if(!e||typeof e!=='object')return null;if(e.props?.onClick?.name==='handlePlexSSO')return e;for(const c of [e.props?.children].flat(Infinity)){const f=findPlex(c);if(f)return f}return null};
 const originalTimeout=globalThis.setTimeout;globalThis.setTimeout=f=>{f();return 0};globalThis.window={open:()=>({closed:false,location:{},close(){this.closed=true}})};
 try {for(const [admin,reject,want] of [[false,false,'/home'],[true,false,'/admin/users?x=1#z'],[true,true,null]]){globalThis.__login={events:[],admin,reject};await findPlex(m.Login()).props.onClick();assert.deepEqual(globalThis.__login.events.slice(0,2),['token','fresh']);assert.equal(globalThis.__login.events[2]?.href,want??undefined);}}finally{globalThis.setTimeout=originalTimeout;delete globalThis.window;}
 globalThis.__login={events:[],admin:false,reject:false,next:'/account?tab=credentials#security'};await findForm(m.Login()).props.onSubmit({preventDefault(){}});assert.deepEqual(globalThis.__login.events[3],{href:'/account?tab=credentials#security',replace:true});
 delete globalThis.__login;
});
test('obsolete password and Plex responses never replace newer credentials',async()=>{
 const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
 globalThis.__race={cleanups:[]};
 const m=await loadFrontend(`export {default as Login} from './src/pages/LoginPage';export * from './src/store/authStore';`,{mock:{filter:s=>s==='react'||/components\/ui|@fortawesome\/react-fontawesome|lib\/plexSignIn|hooks\/useSignInMethods|config\/pluginMetadata|hooks\/useSession|util\/apiClient|@tanstack\/react-router/.test(s),module:s=>{
 if(/components\/ui|@fortawesome\/react-fontawesome/.test(s))return `export const Card='div',CardContent='div',CardHeader='div',CardTitle='div',CardDescription='div',Input='input',Label='label',Button='button',Checkbox='input',Separator='hr',Alert='div',AlertDescription='div',ResponsiveDialog='div',FontAwesomeIcon='i',Spinner='i',Select='div',SelectContent='div',SelectItem='div',SelectTrigger='div',SelectValue='span';`;
 if(s==='react')return `export const useState=v=>[v==='mum'?'plex':v,()=>{}];export const useRef=v=>({current:v});export const useEffect=f=>{globalThis.__race.effects.push(f)};export default {};`;
 if(s.includes('pluginMetadata'))return `export const getServiceIcon=()=>null;export const getServiceMeta=t=>({label:t});`;
 if(s.includes('useSignInMethods'))return `export const useSignInMethods=()=>({serviceSignIn:true,plex:true,servers:[]});`;
 if(s.includes('plexSignIn'))return `export const startPlexSignIn=async()=>({id:'x',authorizationUrl:'https://fixture.invalid',expiresAt:new Date(Date.now()+60000).toISOString()});export const checkPlexSignIn=()=>globalThis.__race.poll.promise;`;
 if(s.includes('useSession'))return `import {getAuthSnapshot} from '@/store/authStore';export const readFreshSession=async checkpoint=>{const auth=getAuthSnapshot();const session=await globalThis.__race.fresh.promise;checkpoint?.(auth);return session};export const useSession=()=>({session:null});`;
 if(s.includes('apiClient'))return `export class ApiError extends Error{};export const requestJson=()=>globalThis.__race.password.promise;`;
 return `export const useNavigate=()=>p=>globalThis.__race.nav.push(p);export const useLocation=()=>({state:{}});export const useSearch=()=>({next:'/account?tab=credentials#z'});`;
 }}});
 const find=(e,p)=>{if(!e||typeof e!=='object')return null;if(p(e))return e;for(const c of [e.props?.children].flat(Infinity)){const f=find(c,p);if(f)return f}return null};
 const timer=globalThis.setTimeout;globalThis.setTimeout=f=>{f();return 0};globalThis.window={innerWidth:0,sessionStorage:{getItem(){return null}},open:()=>({closed:false,location:{},close(){this.closed=true}})};
 try{
 for(const method of ['password','plex'])for(const interruption of ['unmount','logout','switch','compete','during-session']){
  m.clearAccessToken();globalThis.__race={effects:[],nav:[],password:deferred(),poll:deferred(),fresh:deferred()};const f=globalThis.__race;const page=m.Login();const cleanups=f.effects.map(e=>e()).filter(e=>typeof e==='function');
  const submit=()=>find(page,e=>e.type==='form').props.onSubmit({preventDefault(){}});
  const plex=()=>find(page,e=>e.props?.onClick?.name==='handlePlexSSO').props.onClick();
  const pending=method==='password'?submit():plex();await Promise.resolve();await Promise.resolve();
  if(interruption==='during-session'){if(method==='password')f.password.resolve({data:{access_token:'obsolete'}});else f.poll.resolve({status:'signed_in',accessToken:'obsolete'});await Promise.resolve();await Promise.resolve();}
  if(interruption==='unmount')cleanups.forEach(c=>c());else if(interruption==='logout')m.clearAccessToken();else if(interruption==='compete'){const newer=method==='password'?plex():submit();if(method==='password')f.poll.resolve({status:'signed_in',accessToken:'newer'});else f.password.resolve({data:{access_token:'newer'}});f.fresh.resolve({user:{has_admin_access:true}});await newer;f.nav=[];}else m.setAccessToken('newer');
  const before=m.getAccessToken();if(method==='password')f.password.resolve({data:{access_token:'obsolete'}});else f.poll.resolve({status:'signed_in',accessToken:'obsolete'});f.fresh.resolve({user:{has_admin_access:true}});await pending;
  assert.equal(m.getAccessToken(),before,method+' '+interruption);assert.equal(f.nav.length,0,method+' '+interruption);
  cleanups.forEach(c=>c());
 }
 }finally{globalThis.setTimeout=timer;delete globalThis.window;delete globalThis.__race;}
});

test('both login methods accept own session rotation and always release latest loading',async()=>{
 globalThis.__rotation={};
 const m=await loadFrontend(`export {default as Login} from './src/pages/LoginPage';export * from './src/store/authStore';`,{mock:{filter:s=>s==='react'||s==='swr'||/components\/ui|@fortawesome\/react-fontawesome|lib\/plexSignIn|hooks\/useSignInMethods|config\/pluginMetadata|util\/apiClient|@tanstack\/react-router/.test(s),module:s=>{
 if(/components\/ui|@fortawesome\/react-fontawesome/.test(s))return `export const Card='div',CardContent='div',CardHeader='div',CardTitle='div',CardDescription='div',Input='input',Label='label',Button='button',Checkbox='input',Separator='hr',Alert='div',AlertDescription='div',ResponsiveDialog='div',FontAwesomeIcon='i',Spinner='i',Select='div',SelectContent='div',SelectItem='div',SelectTrigger='div',SelectValue='span';`;
 if(s==='react')return `export const useState=v=>{const i=globalThis.__rotation.state.length;globalThis.__rotation.state.push(v);return [v==='mum'?'plex':v,x=>globalThis.__rotation.state[i]=x]};export const useRef=v=>({current:v});export const useEffect=()=>{};export const useSyncExternalStore=(s,get)=>get();export default {};`;
 if(s==='swr')return `export default ()=>({});`;
 if(s.includes('pluginMetadata'))return `export const getServiceIcon=()=>null;export const getServiceMeta=t=>({label:t});`;
 if(s.includes('useSignInMethods'))return `export const useSignInMethods=()=>({serviceSignIn:true,plex:true,servers:[]});`;
 if(s.includes('plexSignIn'))return `export const startPlexSignIn=async()=>({id:'x',authorizationUrl:'https://fixture.invalid',expiresAt:new Date(Date.now()+60000).toISOString()});export const checkPlexSignIn=async()=>({status:'signed_in',accessToken:'initial'});`;
 if(s.includes('apiClient'))return `export class ApiError extends Error{constructor(m,s){super(m);this.status=s}};export async function requestJson(path){if(path==='/api/auth/login')return {data:{access_token:'initial'}};const f=globalThis.__rotation;f.reads++;if(f.reads===1||f.mode==='repeated401')throw new ApiError('session rejected',401);if(f.mode==='externalLogout'||f.mode==='externalSwitch'){f.invalidate();return {data:{user:{has_admin_access:true}}}}if(f.mode==='concurrent'){const data={user:{has_admin_access:true}};await f.rotate();return {data}}return {data:{user:{has_admin_access:false}}};}`;
 return `export const useNavigate=()=>p=>globalThis.__rotation.nav.push(p);export const useLocation=()=>({state:{}});export const useSearch=()=>({next:'/admin/users'});`;
 }}});
 const find=(e,p)=>{if(!e||typeof e!=='object')return null;if(p(e))return e;for(const c of [e.props?.children].flat(Infinity)){const f=find(c,p);if(f)return f}return null};
 const timer=globalThis.setTimeout,fetch=globalThis.fetch;globalThis.setTimeout=f=>{f();return 0};globalThis.window={open:()=>({closed:false,location:{},close(){}})};
 try{for(const method of ['password','plex'])for(const mode of ['success','failedRefresh','repeated401','concurrent','externalLogout','externalSwitch']){
 m.clearAccessToken();globalThis.__rotation={state:[],nav:[],reads:0,mode,rotate:()=>m.refreshAccessToken(),invalidate:()=>mode==='externalLogout'?m.clearAccessToken():m.setAccessToken('newer')};const f=globalThis.__rotation;
 globalThis.fetch=async()=>({ok:mode!=='failedRefresh',json:async()=>({data:{access_token:f.reads>1?'newer':'rotated'}})});
 const page=m.Login();await (method==='password'?find(page,e=>e.type==='form').props.onSubmit({preventDefault(){}}):find(page,e=>e.props?.onClick?.name==='handlePlexSSO').props.onClick());
 assert.equal(f.state[method==='password'?3:4],false,method+' '+mode+' loading');
 if(mode==='success'){assert.equal(f.nav[0]?.href,'/home',method+' rotation destination');assert.equal(m.getAccessToken(),'rotated');}
 else {assert.equal(f.nav.length,0,method+' '+mode+' navigation');assert.ok(f.state[6],method+' '+mode+' error');if(mode==='concurrent'||mode==='externalSwitch')assert.equal(m.getAccessToken(),'newer');}
 }}finally{globalThis.setTimeout=timer;globalThis.fetch=fetch;delete globalThis.window;delete globalThis.__rotation;}
});


// An account that is already signed in is sent on from /login exactly as after
// signing in, but never while a sign-in on the page is pending.
test('the login page sends an already signed-in account on',async()=>{
 const m=await loadFrontend(`export {default as Login} from './src/pages/LoginPage';`,{mock:{filter:s=>s==='react'||/components\/ui|@fortawesome\/react-fontawesome|lib\/plexSignIn|hooks\/useSignInMethods|config\/pluginMetadata|hooks\/useSession|util\/tokenStore|util\/apiClient|@tanstack\/react-router/.test(s),module:s=>{
 if(/components\/ui|@fortawesome\/react-fontawesome/.test(s))return `export const Card='div',CardContent='div',CardHeader='div',CardTitle='div',CardDescription='div',Input='input',Label='label',Button='button',Checkbox='input',Separator='hr',Alert='div',AlertDescription='div',ResponsiveDialog='div',FontAwesomeIcon='i',Spinner='i',Select='div',SelectContent='div',SelectItem='div',SelectTrigger='div',SelectValue='span';`;
 if(s==='react')return `export const useState=v=>{const f=globalThis.__signed;const i=f.index++;return [i in f.states?f.states[i]:v,()=>{}]};export const useRef=v=>({current:v});export const useEffect=e=>{if(e.length===0&&String(e).includes('postLoginPath'))e()};export default {};`;
 if(s.includes('pluginMetadata'))return `export const getServiceIcon=()=>null;export const getServiceMeta=t=>({label:t});`;
 if(s.includes('useSignInMethods'))return `export const useSignInMethods=()=>({serviceSignIn:true,plex:true,servers:[]});`;
 if(s.includes('plexSignIn'))return `export const startPlexSignIn=async()=>({});export const checkPlexSignIn=async()=>({});`;
 if(s.includes('useSession'))return `export const readFreshSession=async()=>{throw new Error('not used')};export const useSession=()=>({session:globalThis.__signed.session});`;
 if(s.includes('tokenStore'))return `export const setAccessToken=()=>{};`;
 if(s.includes('apiClient'))return `export class ApiError extends Error{};export const requestJson=async()=>({});`;
 return `export const useNavigate=()=>p=>globalThis.__signed.nav.push(p);export const useLocation=()=>({state:{}});export const useSearch=()=>({next:globalThis.__signed.next});`;
 }}});
 const cases=[
  [{user:{has_admin_access:true}},'/admin/users?x=1#z',{},{href:'/admin/users?x=1#z',replace:true}],
  [{user:{has_admin_access:false}},'/admin/users',{},{href:'/home',replace:true}],
  [{user:{has_admin_access:true}},'//evil.example',{},{href:'/home',replace:true}],
  [{user:{has_admin_access:false}},undefined,{},{href:'/home',replace:true}],
  [null,'/account',{},undefined],
  [{user:{has_admin_access:true}},'/account',{3:true},undefined],
  [{user:{has_admin_access:true}},'/account',{4:true},undefined],
 ];
 try{for(const [session,next,states,want] of cases){
  globalThis.__signed={session,next,states,index:0,nav:[]};m.Login();
  assert.deepEqual(globalThis.__signed.nav[0],want,JSON.stringify({session,next,states}));
  assert.ok(globalThis.__signed.nav.length<=1);
 }}finally{delete globalThis.__signed;}
});
