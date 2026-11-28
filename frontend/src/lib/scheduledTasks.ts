import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
import {onConnectionChange,subscribeToChannel} from './realtimeSocket';
export type SyncTask={server_id:number;server_name:string;provider:string;scope:'users'|'libraries';revision:number;server_revision:number;enabled:boolean;interval_seconds:number;state:'disabled'|'stopped'|'paused'|'scheduled'|'running'|'recovering';next_run_time:string|null;started_at:string|null;finished_at:string|null;last_code:'NEVER_RUN'|'SUCCEEDED'|'WARNINGS'|'FAILED'|'CANCELLED'|'INTERRUPTED';attempts:number;progress:RefreshProgress|null};
// How far a running refresh has got: phase 'list' reads the server's list,
// 'items' a library's items, 'episodes'/'tracks' each show or album. total 0 = unknown.
export type RefreshProgress={library:string;phase:'list'|'items'|'episodes'|'tracks';done:number;total:number;current:string};
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
export function readRefreshProgress(v:any):RefreshProgress|null{
 if(v===null||v===undefined)return null;
 if(typeof v!=='object'||typeof v.library!=='string'||v.library.length>512||!['list','items','episodes','tracks'].includes(v.phase)||!count(v.done)||!count(v.total)||typeof v.current!=='string'||v.current.length>512)throw Error('Invalid refresh progress');
 return{library:v.library,phase:v.phase,done:v.done,total:v.total,current:v.current};
}
export type TaskSnapshot={actor_uuid:string;configuration_available:boolean;runtime_available:boolean;checkpoint_error:boolean;generated_at:string;tasks:SyncTask[]};
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const timestamp=(v:unknown)=>v===null||typeof v==='string'&&Number.isFinite(Date.parse(v));
export async function fetchScheduledTasks(actor:string,signal?:AbortSignal):Promise<TaskSnapshot>{
 const token=getAccessToken();const{data:p}=await requestJson<{data:TaskSnapshot}>('/api/settings/scheduled-tasks',{retryAuthentication:false,signal});
 if(!token||token!==getAccessToken()||signal?.aborted||p?.actor_uuid!==actor||typeof p.configuration_available!=='boolean'||typeof p.runtime_available!=='boolean'||typeof p.checkpoint_error!=='boolean'||typeof p.generated_at!=='string'||!timestamp(p.generated_at)||!Array.isArray(p.tasks)||p.tasks.length>2000)throw Error('Task status is unavailable. Refresh.');
 const seen=new Set<string>(),tasks:SyncTask[]=[];
 for(const t of p.tasks){if(!t||!positive(t.server_id)||seen.has(`${t.server_id}:${t.scope}`)||!positive(t.revision)||(!Number.isSafeInteger(t.server_revision)||t.server_revision<0)||typeof t.server_name!=='string'||!t.server_name||!['plex','jellyfin','emby','kavita','audiobookshelf','komga','romm','tofa'].includes(t.provider)||!['users','libraries'].includes(t.scope)||typeof t.enabled!=='boolean'||!Number.isSafeInteger(t.interval_seconds)||t.interval_seconds<60||t.interval_seconds>86400||!['disabled','stopped','paused','scheduled','running','recovering'].includes(t.state)||!timestamp(t.next_run_time)||!timestamp(t.started_at)||!timestamp(t.finished_at)||!['NEVER_RUN','SUCCEEDED','WARNINGS','FAILED','CANCELLED','INTERRUPTED'].includes(t.last_code)||!Number.isSafeInteger(t.attempts)||t.attempts<0||t.state==='disabled'&&t.enabled||t.state==='scheduled'&&(!t.enabled||t.next_run_time===null)||['running','recovering'].includes(t.state)&&t.started_at===null)throw Error('Invalid scheduled task record');seen.add(`${t.server_id}:${t.scope}`);tasks.push({server_id:t.server_id,server_name:t.server_name,provider:t.provider,scope:t.scope,revision:t.revision,server_revision:t.server_revision,enabled:t.enabled,interval_seconds:t.interval_seconds,state:t.state,next_run_time:t.next_run_time,started_at:t.started_at,finished_at:t.finished_at,last_code:t.last_code,attempts:t.attempts,progress:t.state==='running'?readRefreshProgress(t.progress):null});}
 return{actor_uuid:actor,configuration_available:p.configuration_available,runtime_available:p.runtime_available,checkpoint_error:p.checkpoint_error,generated_at:p.generated_at,tasks};
}
export const TASKS_EVENT='mum:scheduled-tasks-changed';
export const TASKS_CHANNEL='system.scheduled_tasks';
// The server says when the task list changes (a refresh starts or finishes, a
// schedule changes); the event only triggers a read. A reconnect reads again
// too, since events sent while disconnected are missed.
export type TaskProgressEvent={server_id:number;scope:'users'|'libraries';progress:RefreshProgress};
export function watchScheduledTasks(refresh:()=>void,onProgress?:(update:TaskProgressEvent)=>void){
 const token=getAccessToken();
 if(!token)return()=>{};
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
 const invalidate=()=>{if(stopped||getAccessToken()!==token||timer!==undefined)return;timer=setTimeout(()=>{timer=undefined;if(!stopped&&getAccessToken()===token)refresh();},100);};
 const connection=onConnectionChange(connected=>{if(connected)invalidate();});
 const unsubscribe=subscribeToChannel(TASKS_CHANNEL,event=>{
  if(event.channel!==TASKS_CHANNEL||stopped||getAccessToken()!==token)return;
  if(event.type==='ScheduledTasksChanged')invalidate();
  else if(event.type==='ScheduledTaskProgress'&&onProgress){
   // A malformed update is ignored; the next read corrects the list.
   const p=event.payload as any;
   try{if(positive(p?.server_id)&&(p.scope==='users'||p.scope==='libraries')){const progress=readRefreshProgress(p.progress);if(progress)onProgress({server_id:p.server_id,scope:p.scope,progress});}}catch{/* ignored */}
  }
 });
 return()=>{stopped=true;if(timer!==undefined)clearTimeout(timer);unsubscribe();connection();};
}
