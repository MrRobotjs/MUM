import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';
const directory=fileURLToPath(new URL('../frontend/',import.meta.url));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const flush=async()=>{for(let n=0;n<12;n++)await new Promise(r=>setImmediate(r));};
const actor='12345678-1234-1234-1234-123456789abc';
function harness(){
 const h={params:{serverId:'1',libraryId:'1',mediaId:'10'},tab:'episodes',auth:{user:{uuid:actor},isAdministrator:true},alerts:[],instances:[],current:null};
 h.useState=initial=>{const c=h.current,i=c.index++;if(!(i in c.slots))c.slots[i]=typeof initial==='function'?initial():initial;return [c.slots[i],value=>{c.slots[i]=typeof value==='function'?value(c.slots[i]):value}];};
 h.useRef=initial=>{const c=h.current,i=c.index++;return c.slots[i]??(c.slots[i]={current:initial});};
 h.useEffect=(effect,deps)=>{const c=h.current,i=c.index++,old=c.slots[i];if(!old||!deps||deps.some((v,n)=>!Object.is(v,old.deps[n]))){c.effects.push(()=>{old?.cleanup?.();c.slots[i]={deps,cleanup:effect()};});}};
 h.dispose=c=>{for(const s of c?.slots??[])s?.cleanup?.();};
 h.render=component=>{let node={type:component,props:{},key:'root'},depth=0;while(typeof node?.type==='function'){
  const key=node.key??node.type;let c=h.instances[depth];if(!c||c.key!==key||c.type!==node.type){h.dispose(c);c=h.instances[depth]={key,type:node.type,slots:[],effects:[]};}
  h.current=c;c.index=0;node=node.type(node.props);const effects=c.effects.splice(0);for(const run of effects)run();depth++;
 }for(let i=depth;i<h.instances.length;i++)h.dispose(h.instances[i]);h.instances.length=depth;return node;};
 h.close=()=>{for(const c of h.instances)h.dispose(c);};return h;
}
async function load(h){
 globalThis.catalogueView=h;
 const stubs=new Map();
 for(const name of ['LibraryDetailPage','MediaDetailPage']){
  const source=await readFile(new URL(`../frontend/src/pages/${name}.tsx`,import.meta.url),'utf8');
  for(const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)){
   const path=match[2];if(/apiClient|libraryCatalogue|catalogueView|authStore/.test(path)||path==='react')continue;
   stubs.set(path,[...new Set([...(stubs.get(path)??[]),...match[1].split(',').map(v=>v.trim()).filter(Boolean)])]);
  }
 }
 
 const m=await loadFrontend("export {LibraryDetailPage} from './src/pages/LibraryDetailPage';export {MediaDetailPage} from './src/pages/MediaDetailPage';export {setAccessToken} from './src/store/authStore';export {useLibrarySyncStatus} from './src/hooks/useLibrarySyncStatus';",{mock:{filter:p=>p==='react'||p==='react/jsx-runtime'||stubs.has(p)||p.endsWith('/AuthContext'),module:path=>(a=>{
  if(a.path==='react/jsx-runtime')return {contents:'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;export const Fragment="fragment";'};
  if(a.path==='react')return {contents:'export const useState=v=>globalThis.catalogueView.useState(v);export const useRef=v=>globalThis.catalogueView.useRef(v);export const useEffect=(f,d)=>globalThis.catalogueView.useEffect(f,d);export const useMemo=(f,d)=>f();export const useSyncExternalStore=(s,r)=>r();'};
  const special={useParams:'()=>globalThis.catalogueView.params',useSearch:'()=>({tab:globalThis.catalogueView.tab})',useNavigate:'()=>()=>{}',useAuth:'()=>globalThis.catalogueView.auth',useAccountDisplay:'()=>({formatTimestamp:v=>v})',useAlerts:'()=>Object.fromEntries(["success","error","info"].map(k=>[k,v=>globalThis.catalogueView.alerts.push([k,v])]))',useLibrarySyncStatus:'()=>({status:{is_syncing:false},refetch:async()=>{}})',getServicePalette:'()=>({})',getServiceMeta:'()=>({label:"Jellyfin"})',formatCalendarDate:'v=>v'};
  return {contents:(stubs.get(a.path)??['useAuth']).map(n=>`export const ${n}=${special[n]??JSON.stringify(n)};`).join('')};
 })({path}).contents}});m.setAccessToken('session-a');return m;
}
const nodes=node=>[node,...(Array.isArray(node?.props?.children)?node.props.children:[node?.props?.children]).filter(Boolean).flatMap(nodes)];
const button=(node,label)=>nodes(node).find(n=>n?.type==='Button'&&text(n).trim()===label);
const text=node=>typeof node==='string'?node:Array.isArray(node)?node.map(text).join(' '):text(node?.props?.children??'');
const show=(id,title)=>({data:{id,title,item_type:'show',episode_revision:1,catalogue_supported:true,episode_catalogue_supported:true,library:{id:1,name:'TV',library_type:'series',server:{service_type:'jellyfin'}}}});
const episodes=title=>({data:{episodes:[{id:1,title,season_number:1,episode_number:1}]},meta:{pagination:{total_pages:1,total_items:1}}});

test('catalogue page async boundaries',async t=>{
 const old={fetch:globalThis.fetch,window:globalThis.window,catalogueView:globalThis.catalogueView};t.after(()=>Object.assign(globalThis,old));globalThis.window={location:{origin:'http://mum.test'},confirm:()=>true};
 await t.test('changing between two series reloads episodes and hides the previous series',async()=>{
  const h=harness(),m=await load(h);t.after(h.close);const calls=[];globalThis.fetch=async req=>{const p=new URL(req.url).pathname;calls.push(p);return Response.json(p.endsWith('/episodes')?episodes(p.includes('/20/')?'Episode B':'Episode A'):show(p.endsWith('/20')?20:10,p.endsWith('/20')?'Show B':'Show A'));};
  h.render(m.MediaDetailPage);await flush();h.render(m.MediaDetailPage);await flush();assert.match(text(h.render(m.MediaDetailPage)),/Episode A/);
  h.params={serverId:'1',libraryId:'1',mediaId:'20'};h.render(m.MediaDetailPage);await flush();h.render(m.MediaDetailPage);await flush();const view=text(h.render(m.MediaDetailPage));assert.match(view,/Show B/);assert.match(view,/Episode B/);assert.doesNotMatch(view,/Episode A/);assert.ok(calls.includes('/api/libraries/1/media/20/episodes'));
 });
 await t.test('a late item response cannot overwrite a newer route',async()=>{
  const h=harness(),m=await load(h),pending=deferred();t.after(h.close);globalThis.fetch=async req=>req.url.includes('/media/10?')?pending.promise:Response.json(req.url.includes('/episodes')?episodes('B only'):show(20,'Show B'));
  h.render(m.MediaDetailPage);h.params={serverId:'1',libraryId:'1',mediaId:'20'};h.render(m.MediaDetailPage);await flush();h.render(m.MediaDetailPage);pending.resolve(Response.json(show(10,'Stale Show A')));await flush();const view=text(h.render(m.MediaDetailPage));assert.match(view,/Show B/);assert.doesNotMatch(view,/Stale Show A/);
 });
 await t.test('a late read after token replacement is discarded without authentication replay',async()=>{
  const h=harness(),m=await load(h),pending=deferred(),calls=[];t.after(h.close);globalThis.fetch=async req=>{calls.push(req.url);return pending.promise;};h.render(m.MediaDetailPage);m.setAccessToken('session-b');pending.resolve(Response.json(show(10,'Old session title')));await flush();assert.doesNotMatch(text(h.render(m.MediaDetailPage)),/Old session title/);assert.equal(calls.filter(v=>v.includes('/auth/refresh')).length,0);
 });
 await t.test('two same-turn sync clicks admit one mutation',async()=>{
  const h=harness(),m=await load(h),pending=deferred();t.after(h.close);let posts=0;
  globalThis.fetch=async req=>{if(req.method==='POST'){posts++;return pending.promise;}return Response.json(req.url.includes('/episodes')?episodes('A'):show(10,'Show A'));};
  h.render(m.MediaDetailPage);await flush();h.render(m.MediaDetailPage);await flush();const page=h.render(m.MediaDetailPage),sync=button(page,'Sync');assert.ok(sync);const first=sync.props.onClick(),second=sync.props.onClick();await flush();pending.resolve(Response.json({data:{success:true,library_id:1,item_id:10,source_revision:1,revision:2,result:{added:1,updated:0,removed:0,total:1}}}));await Promise.all([first,second]);assert.equal(posts,1);
 });
 await t.test('a mutation completion after sign-out emits no alert or follow-up read',async()=>{
  const h=harness(),m=await load(h),pending=deferred();t.after(h.close);const calls=[];
  globalThis.fetch=async req=>{calls.push(req.method+' '+new URL(req.url).pathname);return req.method==='POST'?pending.promise:Response.json(req.url.includes('/episodes')?episodes('A'):show(10,'Show A'));};
  h.render(m.MediaDetailPage);await flush();h.render(m.MediaDetailPage);await flush();const task=button(h.render(m.MediaDetailPage),'Sync').props.onClick();await flush();const count=calls.length;m.setAccessToken(null);pending.resolve(Response.json({data:{success:true,library_id:1,item_id:10,source_revision:1,revision:2,message:'committed',result:{added:1,updated:0,removed:0,total:1}}}));await task;assert.deepEqual(h.alerts,[]);assert.equal(calls.length,count);
 });
 await t.test('library detail discards a late read from another library',async()=>{
  const h=harness(),m=await load(h),pending=deferred();t.after(h.close);h.tab='overview';
  globalThis.fetch=async req=>req.url.includes('/libraries/1?')?pending.promise:Response.json({data:{id:2,name:'Library B',library_type:'movies',catalogue:{supported:true,revision:1},server:{service_type:'jellyfin'}}});
  h.render(m.LibraryDetailPage);h.params={serverId:'1',libraryId:'2'};h.render(m.LibraryDetailPage);await flush();pending.resolve(Response.json({data:{id:1,name:'Stale Library A',library_type:'movies',server:{service_type:'jellyfin'}}}));await flush();const page=text(h.render(m.LibraryDetailPage));assert.match(page,/Library B/);assert.doesNotMatch(page,/Stale Library A/);
 });

 await t.test('mutation reconciliation does not reload a superseded episode sort',async()=>{
  const h=harness(),m=await load(h),pending=deferred(),calls=[];t.after(h.close);
  globalThis.fetch=async req=>{calls.push(req.method+' '+req.url);return req.method==='POST'?pending.promise:Response.json(req.url.includes('/episodes')?episodes('A'):show(10,'Show A'));};
  h.render(m.MediaDetailPage);await flush();h.render(m.MediaDetailPage);await flush();let page=h.render(m.MediaDetailPage);const task=button(page,'Sync').props.onClick();nodes(page).find(n=>n?.type==='Select'&&n.props.value==='season_episode_asc').props.onValueChange('title_desc');h.render(m.MediaDetailPage);await flush();const count=calls.length;
  pending.resolve(Response.json({data:{success:true,library_id:1,item_id:10,source_revision:1,revision:2,result:{added:0,updated:0,removed:0,total:1}}}));await task;assert.equal(calls.slice(count).filter(v=>v.includes('/episodes?')&&v.includes('season_episode_asc')).length,0);
 });
 await t.test('failed inspection keeps mutations blocked until explicit successful reads',async()=>{
  const h=harness(),m=await load(h);t.after(h.close);let posts=0,fail=false;
  globalThis.fetch=async req=>{if(req.method==='POST'){posts++;fail=true;throw new TypeError('lost reply');}if(fail)return Response.json({error:{code:'UNAVAILABLE',message:'read failed'}},{status:503});return Response.json(req.url.includes('/episodes')?episodes('A'):show(10,'Show A'));};
  h.render(m.MediaDetailPage);await flush();h.render(m.MediaDetailPage);await flush();await button(h.render(m.MediaDetailPage),'Sync').props.onClick();let page=h.render(m.MediaDetailPage);assert.match(text(page),/Inspect saved state/);await button(page,'Sync').props.onClick();assert.equal(posts,1);fail=false;await button(page,'Refresh saved state').props.onClick();page=h.render(m.MediaDetailPage);assert.doesNotMatch(text(page),/Inspect saved state/);await button(page,'Sync').props.onClick();assert.equal(posts,2);
 });

 await t.test('the newest episode query wins even when an aborted fetch replies late',async()=>{
  const h=harness(),m=await load(h),pending=deferred();t.after(h.close);
  globalThis.fetch=async req=>{if(!req.url.includes('/episodes'))return Response.json(show(10,'Show A'));if(req.url.includes('season_episode_asc'))return pending.promise;return Response.json(episodes('Newest sorted episode'));};
  h.render(m.MediaDetailPage);await flush();let page=h.render(m.MediaDetailPage);nodes(page).find(n=>n?.type==='Select'&&n.props.value==='season_episode_asc').props.onValueChange('title_desc');h.render(m.MediaDetailPage);await flush();pending.resolve(Response.json(episodes('Stale sorted episode')));await flush();page=text(h.render(m.MediaDetailPage));assert.match(page,/Newest sorted episode/);assert.doesNotMatch(page,/Stale sorted episode/);
 });
 await t.test('sync polling shares an in-flight request and ignores token-replaced replies',async()=>{
  const h=harness(),m=await load(h),pending=deferred();t.after(h.close);let calls=0,result;
  globalThis.fetch=async()=>{calls++;return pending.promise;};const Component=()=>{result=m.useLibrarySyncStatus('1',100000);return null;};h.render(Component);const a=result.refetch(),b=result.refetch();assert.equal(calls,1);m.setAccessToken('replacement');pending.resolve(Response.json({data:{library_id:1,is_syncing:true}}));await Promise.all([a,b]);h.render(Component);assert.equal(result.status.is_syncing,false);
 });
 await t.test('a library sync finishing after navigation does not refresh the new library',async()=>{
  const h=harness(),m=await load(h),pending=deferred(),calls=[];t.after(h.close);h.tab='overview';
  globalThis.fetch=async req=>{calls.push(req.method+' '+req.url);if(req.method==='POST')return pending.promise;return Response.json(req.url.includes('/media?')?{data:[],meta:{pagination:{total_pages:1,total_items:0}}}:{data:{id:Number(h.params.libraryId),name:'Library '+h.params.libraryId,library_type:'movies',catalogue:{supported:true,revision:1},server:{service_type:'jellyfin'}}});};
  h.render(m.LibraryDetailPage);await flush();const page=h.render(m.LibraryDetailPage);button(page,'Sync Library')?.props.onClick();
  // The existing label is "Sync" on this toolbar.
  if(!calls.some(v=>v.startsWith('POST')))button(page,'Sync').props.onClick();await flush();h.params={serverId:'1',libraryId:'2'};h.render(m.LibraryDetailPage);await flush();const count=calls.length;pending.resolve(Response.json({data:{success:true,library_id:1,source_revision:1,revision:2,message:'done',result:{added:1,updated:0,removed:0,total:1}}}));await flush();assert.equal(calls.length,count);assert.deepEqual(h.alerts,[]);
 });

 await t.test('a detail reply for a different item cannot authorize controls in this route',async()=>{
  const h=harness(),m=await load(h);t.after(h.close);globalThis.fetch=async()=>Response.json(show(20,'Foreign item'));
  h.render(m.MediaDetailPage);await flush();const page=h.render(m.MediaDetailPage);assert.doesNotMatch(text(page),/Foreign item/);assert.equal(button(page,'Sync'),undefined);
 });

 await t.test('Plex item capability never enables episode requests or actions',async()=>{
  const h=harness(),m=await load(h),calls=[];t.after(h.close);
  globalThis.fetch=async req=>{calls.push(req.method+' '+new URL(req.url).pathname);const reply=show(10,'Plex Show');reply.data.episode_catalogue_supported=false;reply.data.library.server.service_type='plex';return Response.json(reply);};
  h.render(m.MediaDetailPage);await flush();h.render(m.MediaDetailPage);await flush();const page=h.render(m.MediaDetailPage);assert.equal(button(page,'Sync').props.disabled,true);await button(page,'Sync').props.onClick();assert.equal(calls.some(v=>v.includes('/episodes')||v.startsWith('POST')),false);
 });
 await t.test('unimplemented Plex collections are visibly unavailable without a request',async()=>{
  const h=harness(),m=await load(h),calls=[];t.after(h.close);h.tab='collections';
  globalThis.fetch=async req=>{calls.push(new URL(req.url).pathname);return Response.json({data:{id:1,name:'Plex Movies',library_type:'movie',catalogue:{supported:true,revision:1,collections_supported:false},server:{service_type:'plex'}}});};
  h.render(m.LibraryDetailPage);await flush();h.render(m.LibraryDetailPage);await flush();assert.equal(calls.some(p=>p.endsWith('/collections')),false);assert.match(text(h.render(m.LibraryDetailPage)),/Collections Not Available/);
 });

 const plexLibrary={data:{id:1,name:'Plex Movies',library_type:'movie',catalogue:{supported:true,revision:1,collections_supported:true},server:{service_type:'plex'}}};
 const collection={id:7,title:'Heists',child_count:3,smart:true,thumb:'/api/media/collections/images/7?s=a&e=1&g=x',added_at:'2026-01-01T00:00:00Z'};
 await t.test('supported Plex collections render saved rows with signed posters',async()=>{
  const h=harness(),m=await load(h),calls=[];t.after(h.close);h.tab='collections';
  globalThis.fetch=async req=>{const path=new URL(req.url).pathname;calls.push(path);return Response.json(path.endsWith('/collections')?{data:{collections:[collection],catalogue_revision:1}}:plexLibrary);};
  h.render(m.LibraryDetailPage);await flush();h.render(m.LibraryDetailPage);await flush();const page=h.render(m.LibraryDetailPage);
  assert.equal(calls.filter(p=>p==='/api/libraries/1/collections').length,1);assert.match(text(page),/Collections in\s+Plex Movies/);assert.equal(nodes(page).filter(n=>n?.props?.collection).length,1);
  const card=nodes(page).find(n=>n?.props?.collection);assert.equal(card.key,7);
  const view=harness();globalThis.catalogueView=view;const tree=view.render(()=>card);
  assert.equal(nodes(tree).find(n=>n?.type==='img').props.src,collection.thumb);assert.ok(nodes(tree).some(n=>Array.isArray(n?.props?.children)&&n.props.children[0]===3&&n.props.children[1]===' item'));assert.match(text(tree),/Smart/);
  globalThis.catalogueView=h;
 });
 await t.test('collection rows with foreign poster links are refused',async()=>{
  const h=harness(),m=await load(h);t.after(h.close);h.tab='collections';
  globalThis.fetch=async req=>Response.json(new URL(req.url).pathname.endsWith('/collections')?{data:{collections:[{...collection,thumb:'/api/media/plex/images/proxy?path=x'}]}}:plexLibrary);
  h.render(m.LibraryDetailPage);await flush();h.render(m.LibraryDetailPage);await flush();const page=h.render(m.LibraryDetailPage);
  assert.equal(nodes(page).some(n=>n?.props?.collection),false);
 });

});
