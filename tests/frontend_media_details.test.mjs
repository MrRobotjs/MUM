import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {build}=createRequire(new URL('../frontend/package.json',import.meta.url))('esbuild');
async function load(){
 const result=await build({stdin:{contents:"export {MediaDetailsDialog} from './src/components/streaming/MediaDetailsDialog';",resolveDir:fileURLToPath(new URL('../frontend/',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',plugins:[{name:'dialog-boundaries',setup(b){
 b.onResolve({filter:/^react\/jsx-runtime$|\/ui\/(responsive-dialog|button)$|contexts\/AlertContext$|@fortawesome/},a=>({path:a.path,namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},a=>{
  const p=a.path;if(p==='react/jsx-runtime')return{contents:'export const jsx=(type,props,key)=>typeof type==="function"?type(props):({type,props,key});export const jsxs=jsx;'};
  if(p.endsWith('AlertContext'))return{contents:'export const useAlerts=()=>({success(){},error(){}});'};
  if(p.includes('free-solid'))return{contents:'export const faCopy={};'};
  if(p.includes('react-fontawesome'))return{contents:'export const FontAwesomeIcon="icon";'};
  return{contents:p.endsWith('button')?'export const Button="button";':'export const ResponsiveDialog="dialog";'};
 });}}]});return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
}
function text(node){if(node==null||typeof node==='boolean')return '';if(Array.isArray(node))return node.map(text).join(' ');if(typeof node==='string'||typeof node==='number')return String(node);return(Array.isArray(node?.props?.children)?node.props.children:[node?.props?.children]).map(text).join(' ');}
test('Media Details renders selected fields and distinguishes absent voice activity from false',async()=>{
 const {MediaDetailsDialog}=await load();const session={media_path:'/media/Fixture Film.mkv',media_duration:6554720,media_bitrate:7400,media_width:1920,media_height:804,media_audio_channels:6,media_video_codec:'hevc',media_video_profile:'main 10'};
 const render=s=>text(MediaDetailsDialog({open:true,onOpenChange(){},session:s}));
 const populated=render(session);for(const expected of ['/media/Fixture Film.mkv','01:49:14','7.4 Mbps','1920','804','HEVC','MAIN 10'])assert.ok(populated.includes(expected),expected);
 assert.equal(populated.includes('HAS VOICE ACTIVITY'),false);
 const knownFalse=render({...session,media_has_voice_activity:false});assert.ok(knownFalse.includes('HAS VOICE ACTIVITY'));assert.match(knownFalse,/\bNo\b/);
});
