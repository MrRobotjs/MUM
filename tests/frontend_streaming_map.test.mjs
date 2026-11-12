import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {build}=createRequire(new URL('../frontend/package.json',import.meta.url))('esbuild');
const directory=fileURLToPath(new URL('../frontend/',import.meta.url));
async function load(){
 const built=await build({stdin:{contents:"export * from './src/components/settings/StreamingMapSettings';",resolveDir:directory},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',plugins:[{name:'map-boundaries',setup(b){
 b.onResolve({filter:/^(react(?:\/jsx-runtime)?|swr)$|contexts\/AuthContext$|store\/authStore$|util\/apiClient$|\/ui\//},a=>({path:a.path,namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},a=>{
 const p=a.path;
 if(p==='react/jsx-runtime')return{contents:'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;'};
 if(p==='react')return{contents:`export const useState=initial=>{const i=globalThis.mapTest.cursor++;if(!(i in globalThis.mapTest.states))globalThis.mapTest.states[i]=initial;return [globalThis.mapTest.states[i],v=>globalThis.mapTest.states[i]=v]};export const useRef=initial=>{const i=globalThis.mapTest.cursor++;return globalThis.mapTest.states[i]??=( {current:initial})};export const useEffect=()=>{};export const useSyncExternalStore=(s,r)=>r();`};
 if(p==='swr')return{contents:'export default ()=>globalThis.mapTest.swr;'};
 if(p.endsWith('AuthContext'))return{contents:'export const useAuth=()=>({user:{uuid:"actor"},isAdministrator:true});'};
 if(p.endsWith('authStore'))return{contents:'export const getAccessToken=()=>globalThis.mapTest.token;export const getAuthSnapshot=()=>({accessToken:globalThis.mapTest.token});export const subscribeToAuthStore=()=>()=>{};'};
 if(p.endsWith('apiClient'))return{contents:'export const requestJson=(...args)=>globalThis.mapTest.request(...args);'};
 const names=p.endsWith('/card')?['Card','CardContent','CardHeader','CardTitle']:p.endsWith('/responsive-dialog')?['ResponsiveDialog']:[p.split('/').at(-1).replace(/^./,v=>v.toUpperCase())];
 return{contents:names.map(n=>`export const ${n}=${JSON.stringify(n)};`).join('')};
 });}}]});
 return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}#${Math.random()}`);
}
function walk(n){return [n,...(Array.isArray(n?.props?.children)?n.props.children:[n?.props?.children]).filter(Boolean).flatMap(walk)];}
test('map key setup saves once, handles uncertain results and shares the responsive dialog',async t=>{
 const old=globalThis.mapTest;t.after(()=>{globalThis.mapTest=old;});
 const reset=()=>globalThis.mapTest={cursor:0,states:[],token:'session',swr:{data:{configured:false,revision:1},mutate:async()=>{}},request:async()=>({data:{configured:true,revision:2}})};
 reset();const m=await load();let saved=0;
 const render=()=>{globalThis.mapTest.cursor=0;return m.MapKeyForm({base:{configured:false,revision:1},onSaved:async()=>{saved++;}});};
 let tree=render();assert.ok(walk(tree).some(n=>n.type==='a'&&n.props.href==='https://www.carto.com/basemaps/apikey/index.html'));
 walk(tree).find(n=>n.type==='Input').props.onChange({target:{value:' fixture-key '}});tree=render();
 let resolve;let calls=0;globalThis.mapTest.request=async(path,options)=>{calls++;assert.equal(path,'/api/settings/streaming-map');assert.equal(options.retryAuthentication,false);assert.deepEqual(JSON.parse(options.body),{revision:1,api_key:'fixture-key'});return new Promise(r=>resolve=r);};
 const save=walk(tree).find(n=>n.type==='Button');save.props.onClick();save.props.onClick();assert.equal(calls,1);resolve({});await new Promise(r=>setTimeout(r,0));assert.equal(saved,1);assert.equal(walk(render()).find(n=>n.type==='Input').props.value,'');
 reset();tree=render();walk(tree).find(n=>n.type==='Input').props.onChange({target:{value:'fixture-key'}});tree=render();calls=0;globalThis.mapTest.request=async()=>{calls++;throw Error('lost response');};walk(tree).find(n=>n.type==='Button').props.onClick();await new Promise(r=>setTimeout(r,0));tree=render();assert.equal(calls,1);assert.ok(walk(tree).some(n=>n.props?.role==='status'&&String(n.props.children).includes('could not be confirmed')));assert.equal(walk(tree).find(n=>n.type==='Button').props.disabled,true);
 const dialog=m.StreamingMapKeyDialog({open:true,onClose(){}});assert.equal(dialog.type,'ResponsiveDialog');assert.equal(dialog.props.open,true);assert.equal(dialog.props.children.type,m.StreamingMapSettings);
 const first=walk(m.StreamingMapSettings()).find(n=>n.type===m.MapKeyForm);globalThis.mapTest.swr.data={configured:true,revision:2};const next=walk(m.StreamingMapSettings()).find(n=>n.type===m.MapKeyForm);assert.notEqual(first.key,next.key,'external revision replaces drafts rather than silently using a newer revision');
});
