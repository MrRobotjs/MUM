import test from 'node:test';import assert from 'node:assert/strict';import {loadFrontend} from './frontendLoader.mjs';
test('channel ownership closes last consumer and isolates replacement authentication',async t=>{
 const oldW=globalThis.window,oldS=globalThis.WebSocket; t.after(()=>{globalThis.window=oldW;globalThis.WebSocket=oldS;});
 const sockets=[];globalThis.window={location:{href:'http://localhost/home',protocol:'http:'}};
 globalThis.WebSocket=class {static OPEN=1;readyState=1;constructor(){sockets.push(this);}send(){}close(){this.closed=true;}frame(event){this.onmessage?.({data:JSON.stringify({type:'event',event})});}};
 const m=await loadFrontend("export * from './src/lib/realtimeSocket';export {setAccessToken} from './src/store/authStore';");
 m.setAccessToken('a');let a=0,b=0;const ua=m.subscribeToChannel('a',()=>a++),ub=m.subscribeToChannel('b',()=>b++);const first=sockets[0];first.onmessage({data:'{"type":"authenticated"}'});
 ua();ua();assert.ok(!first.closed);first.frame({channel:'b'});assert.equal(b,1);ub();assert.equal(first.closed,true);
 const old=m.subscribeToChannel('a',()=>a++);const second=sockets.at(-1);second.frame({channel:'a'});assert.equal(a,0);m.setAccessToken('b');second.frame({channel:'a'});assert.equal(a,0);assert.equal(second.closed,true);old();m.disconnectRealtimeSocket();
});
test('disabled sync hook suppresses effects and aborts/ignores late privileged results',async()=>{
 const h={states:[],index:0,pending:[],effects:[],requests:[],listeners:[],unsub:0};globalThis.syncHarness=h;
 const m=await loadFrontend("export * from './src/hooks/useSyncStatus';export {setAccessToken} from './src/store/authStore';",{mock:{filter:s=>s==='react'||/realtimeSocket$|apiClient$/.test(s),module:s=>s==='react'?`export const useSyncExternalStore=(subscribe,get)=>get();export const useState=v=>{const h=globalThis.syncHarness,i=h.index++;if(!(i in h.states))h.states[i]=v;return[h.states[i],v=>h.states[i]=typeof v==='function'?v(h.states[i]):v]};export const useEffect=(f,d)=>{const h=globalThis.syncHarness,i=h.index++;if(!h.effects[i]||d.some((v,j)=>v!==h.effects[i].d[j]))h.pending.push(()=>{h.effects[i]?.cleanup?.();h.effects[i]={d,cleanup:f()}})};`:/apiClient$/.test(s)?`export const requestJson=(url,init)=>new Promise(resolve=>globalThis.syncHarness.requests.push({url,init,resolve}));`:`export const connectRealtimeSocket=()=>{};export const subscribeToChannel=(c,f)=>{globalThis.syncHarness.listeners.push(f);return()=>globalThis.syncHarness.unsub++};`}});
 const render=enabled=>{h.index=0;const v=m.useSyncStatus({enabled});h.pending.splice(0).forEach(f=>f());return v;};
 assert.equal(render(false).loading,false);assert.equal(h.requests.length,0);assert.equal(h.listeners.length,0);
 render(true);assert.equal(h.requests.length,1);const callback=h.listeners[0];render(false);assert.equal(h.requests[0].init.signal.aborted,true);assert.equal(h.unsub,1);
 callback({type:'TaskProgress',payload:{is_syncing:true}});h.requests[0].resolve({data:{is_syncing:true}});await Promise.resolve();assert.equal(render(false).syncStatus.is_syncing,false);render(true);const old=h.requests.at(-1);m.setAccessToken('replacement');render(true);assert.equal(old.init.signal.aborted,true);old.resolve({data:{is_syncing:true}});await Promise.resolve();assert.equal(render(true).syncStatus.is_syncing,false);delete globalThis.syncHarness;
});

test('last unsubscribe cancels a pending reconnect and standalone connect has no ownership',async t=>{
 const prior={window:globalThis.window,WebSocket:globalThis.WebSocket,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};t.after(()=>Object.assign(globalThis,prior));let pending=null,created=0;
 globalThis.window={location:{href:'http://localhost',protocol:'http:'}};globalThis.setTimeout=f=>{pending=f;return 123};globalThis.clearTimeout=()=>{pending=null};
 globalThis.WebSocket=class {static OPEN=1;readyState=1;constructor(){created++;globalThis.retrySocket=this}send(){}close(){}};
 const m=await loadFrontend("export * from './src/lib/realtimeSocket';export {setAccessToken} from './src/store/authStore';");m.setAccessToken('a');m.connectRealtimeSocket();assert.equal(created,0);const stop=m.subscribeToChannel('x',()=>{});globalThis.retrySocket.onclose();assert.ok(pending);stop();assert.equal(pending,null);assert.deepEqual(m.getRealtimeState(),{connected:false,channels:[]});delete globalThis.retrySocket;
});

test('sidebar render gives ordinary users Home and no privileged sections',async t=>{
 const {readFile}=await import('node:fs/promises');const source=await readFile(new URL('../frontend/src/components/layout/AppSidebar.tsx',import.meta.url),'utf8');
 const exports=new Map();for(const match of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g))exports.set(match[2],match[1].split(',').map(v=>v.trim()).filter(Boolean));
 globalThis.shellAdmin=false;globalThis.shellSync=[];globalThis.shellSummaries=[];globalThis.shellFreshness='fresh';t.after(()=>{delete globalThis.shellAdmin;delete globalThis.shellSync;delete globalThis.shellSummaries;delete globalThis.shellFreshness});
 const m=await loadFrontend("export * from './src/components/layout/AppSidebar';",{mock:{filter:s=>s==='react'||exports.has(s),module:s=>{
 if(s==='react')return 'export const useState=v=>[typeof v==="function"?v():v,()=>{}];export const useEffect=()=>{};export const useCallback=f=>f;export const useRef=v=>({current:v});';
 const special={useAuth:'()=>({isAdministrator:globalThis.shellAdmin,isOwner:globalThis.shellAdmin,hasAdminAccess:globalThis.shellAdmin,user:{}})',useSidebar:'()=>({isMobile:false,setOpenMobile(){}})',useAlerts:'()=>({success(){},error(){}})',useSyncStatus:'o=>{globalThis.shellSync.push(o);return {syncStatus:{is_syncing:false}}}',useUserPreferences:'()=>({getPreference:()=>false})',useStreamingSummary:'(scope,enabled)=>{globalThis.shellSummaries.push({scope,enabled});return {summary:{servers:[{freshness:"fresh"},{freshness:globalThis.shellFreshness}],fresh_current_observations:"2"}}}',useUserTotal:'()=>null',useSWRConfig:'()=>({mutate(){}})',useLocation:'()=>({pathname:"/home"})',HOME_PATH:'"/home"',USER_TOTAL_KEY_PREFIX:'"users"'};
 return exports.get(s).map(n=>'export const '+n+'='+(special[n]??('function '+n+'(){return null}'))+';').join('');}}});
 const nodes=v=>!v||typeof v!=='object'?[]:[v,...(Array.isArray(v.props?.children)?v.props.children:[v.props?.children]).flatMap(nodes)];
 let tree=nodes(m.AppSidebar({}));assert.deepEqual(globalThis.shellSync.at(-1),{enabled:false});assert.equal(tree.find(n=>n.type?.name==='NavMain').props.items[0].url,'/home');assert.equal(tree.some(n=>['NavServers','NavSettings'].includes(n.type?.name)),false);assert.equal(tree.filter(n=>n.type?.name==='NavMain').length,1);
 globalThis.shellAdmin=true;tree=nodes(m.AppSidebar({}));assert.equal(tree.some(n=>n.type?.name==='NavServers'),true);assert.deepEqual(globalThis.shellSync.at(-1),{enabled:true});assert.deepEqual(globalThis.shellSummaries.at(-1),{scope:'all',enabled:true});const streaming=tree.filter(n=>n.type?.name==='NavMain').flatMap(n=>n.props.items).find(i=>i.title==='Streaming');assert.equal(streaming.statusIndicator.props.children,'2');
 globalThis.shellFreshness='stale';tree=nodes(m.AppSidebar({}));const stale=tree.filter(n=>n.type?.name==='NavMain').flatMap(n=>n.props.items).find(i=>i.title==='Streaming');assert.equal(stale.statusIndicator.props.children,'2+');assert.match(stale.statusIndicator.props.title,/some servers/i);
});
