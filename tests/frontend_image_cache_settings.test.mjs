import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

const flatten=node=>node == null || typeof node!=='object' ? [] : [node,...(Array.isArray(node.props?.children)?node.props.children:[node.props?.children]).flatMap(flatten)];
const strings=node=>node == null ? '' : typeof node==='string' || typeof node==='number' ? String(node) : (Array.isArray(node.props?.children)?node.props.children:[node.props?.children]).map(strings).join(' ');

test('image cache controls present shared and per-server policies and submit guarded changes',async t=>{
  const prior=globalThis.imageCacheUITest;t.after(()=>{globalThis.imageCacheUITest=prior});
  const m=await loadFrontend("export {ImageCacheSettings} from './src/components/settings/ImageCacheSettings';",{mock:{filter:/^react(?:\/jsx-runtime)?$|^\.\.\/\.\.\/contexts$|util\/apiClient$|store\/authStore$|\/ui\/(?:button|card|input|label|select)$/,module:p=>{
    if(p==='react')return 'export const useState=()=>[globalThis.imageCacheUITest.states[globalThis.imageCacheUITest.index++],()=>{}];export const useEffect=()=>{};export const useCallback=f=>f;export const useRef=value=>({current:value});export const useSyncExternalStore=()=>({accessToken:"session"});';
    if(p==='react/jsx-runtime')return 'export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment="Fragment";';
    if(p.endsWith('/contexts'))return 'export const useAlerts=()=>({success(){},error(message){globalThis.imageCacheUITest.error=message}});';
    if(p.endsWith('/apiClient'))return 'export const requestJson=async(path,options)=>{globalThis.imageCacheUITest.calls.push({path,options});return {data:globalThis.imageCacheUITest.settings}};';
    if(p.endsWith('/authStore'))return 'export const getAccessToken=()=>"session";export const getAuthSnapshot=()=>({accessToken:"session"});export const subscribeToAuthStore=()=>()=>{};';
    const types=p.endsWith('/card')?['Card','CardContent','CardHeader','CardTitle','CardDescription']:p.endsWith('/select')?['Select','SelectContent','SelectItem','SelectTrigger','SelectValue']:[p.split('/').at(-1).replace(/^./,c=>c.toUpperCase())];
    return types.map(name=>`export const ${name}=${JSON.stringify(name)};`).join('');
  }}});
  const settings={mode:'shared',shared_limit_mb:1024,revision:3,usage_bytes:2048,available:true,servers:[{id:7,name:'Plex++',provider:'plex',limit_mb:512,usage_bytes:1024}]};
  const render=(serverId,mode=settings.mode,limit='1024')=>{globalThis.imageCacheUITest={states:[settings,mode,limit,false,false],index:0,calls:[],settings};return m.ImageCacheSettings({serverId});};
  let tree=render();assert.match(strings(tree),/Shared across all servers/);assert.match(strings(tree),/Shared cache limit/);
  let button=flatten(tree).find(n=>n.type==='Button'&&strings(n)==='Save cache settings');button.props.onClick();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(globalThis.imageCacheUITest.calls[0].path,'/api/settings/image-cache');assert.deepEqual(JSON.parse(globalThis.imageCacheUITest.calls[0].options.body),{revision:3,mode:'shared',shared_limit_mb:1024});
  settings.mode='per_server';tree=render(7,'per_server','512');assert.match(strings(tree),/Server cache limit/);
  button=flatten(tree).find(n=>n.type==='Button'&&strings(n)==='Save cache settings');button.props.onClick();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(globalThis.imageCacheUITest.calls[0].path,'/api/servers/7/image-cache/limit');assert.deepEqual(JSON.parse(globalThis.imageCacheUITest.calls[0].options.body),{revision:3,limit_mb:512});
  settings.mode='shared';tree=render(7);assert.match(strings(tree),/shared limit in Advanced Settings/);
});
