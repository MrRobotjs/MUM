import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
export type SyncTask={server_id:number;server_name:string;revision:number;server_revision:number;enabled:boolean;interval_seconds:number;state:'disabled'|'stopped'|'paused'|'scheduled'|'running'|'recovering';next_run_time:string|null;started_at:string|null;finished_at:string|null;last_code:'NEVER_RUN'|'SUCCEEDED'|'FAILED'|'CANCELLED'|'INTERRUPTED';attempts:number};
export type TaskSnapshot={actor_uuid:string;configuration_available:boolean;runtime_available:boolean;checkpoint_error:boolean;generated_at:string;tasks:SyncTask[]};
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const timestamp=(v:unknown)=>v===null||typeof v==='string'&&Number.isFinite(Date.parse(v));
export async function fetchScheduledTasks(actor:string,signal?:AbortSignal):Promise<TaskSnapshot>{
 const token=getAccessToken();const{data:p}=await requestJson<{data:TaskSnapshot}>('/api/settings/scheduled-tasks',{retryAuthentication:false,signal});
 if(!token||token!==getAccessToken()||signal?.aborted||p?.actor_uuid!==actor||typeof p.configuration_available!=='boolean'||typeof p.runtime_available!=='boolean'||typeof p.checkpoint_error!=='boolean'||typeof p.generated_at!=='string'||!timestamp(p.generated_at)||!Array.isArray(p.tasks)||p.tasks.length>1000)throw Error('Task status is unavailable. Refresh.');
 const seen=new Set<number>(),tasks:SyncTask[]=[];
 for(const t of p.tasks){if(!t||!positive(t.server_id)||seen.has(t.server_id)||!positive(t.revision)||(!Number.isSafeInteger(t.server_revision)||t.server_revision<0)||typeof t.server_name!=='string'||!t.server_name||typeof t.enabled!=='boolean'||!Number.isSafeInteger(t.interval_seconds)||t.interval_seconds<60||t.interval_seconds>86400||!['disabled','stopped','paused','scheduled','running','recovering'].includes(t.state)||!timestamp(t.next_run_time)||!timestamp(t.started_at)||!timestamp(t.finished_at)||!['NEVER_RUN','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED'].includes(t.last_code)||!Number.isSafeInteger(t.attempts)||t.attempts<0||t.state==='disabled'&&t.enabled||t.state==='scheduled'&&(!t.enabled||t.next_run_time===null)||['running','recovering'].includes(t.state)&&t.started_at===null)throw Error('Invalid scheduled task record');seen.add(t.server_id);tasks.push({server_id:t.server_id,server_name:t.server_name,revision:t.revision,server_revision:t.server_revision,enabled:t.enabled,interval_seconds:t.interval_seconds,state:t.state,next_run_time:t.next_run_time,started_at:t.started_at,finished_at:t.finished_at,last_code:t.last_code,attempts:t.attempts});}
 return{actor_uuid:actor,configuration_available:p.configuration_available,runtime_available:p.runtime_available,checkpoint_error:p.checkpoint_error,generated_at:p.generated_at,tasks};
}
export const TASKS_EVENT='mum:scheduled-tasks-changed';
function refresh(actor:string){try{if(typeof window!=='undefined'&&window.dispatchEvent)window.dispatchEvent(new CustomEvent(TASKS_EVENT,{detail:{actor_uuid:actor}}));}catch{/* Optional read signal. */}}
const pending=new Set<string>();
export async function configureScheduledTask(base:TaskSnapshot,task:SyncTask,enabled:boolean,interval:number){
 if(!base.configuration_available||!base.tasks.some(t=>t.server_id===task.server_id&&t.revision===task.revision&&t.server_revision===task.server_revision)||typeof enabled!=='boolean'||!Number.isSafeInteger(interval)||interval<60||interval>86400||enabled===task.enabled&&interval===task.interval_seconds)throw Error('Refresh owner task settings and choose a valid change.');
 if(pending.has(base.actor_uuid))throw Error('A schedule change is pending.');pending.add(base.actor_uuid);
 const token=getAccessToken(),abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
 try{
  const fresh=await fetchScheduledTasks(base.actor_uuid,abort.signal),current=fresh.tasks.find(t=>t.server_id===task.server_id);
  if(!fresh.configuration_available||token!==getAccessToken()||current?.revision!==task.revision||current.server_revision!==task.server_revision)throw Error('Task changed');
  const{data:r}=await requestJson<{data:{actor_uuid:string;server_id:number;revision:number}}>(`/api/settings/scheduled-tasks/${task.server_id}`,{method:'PUT',retryAuthentication:false,signal:abort.signal,body:JSON.stringify({expected_actor_uuid:base.actor_uuid,revision:task.revision,server_revision:task.server_revision,enabled,interval_seconds:interval})});
  if(token!==getAccessToken()||abort.signal.aborted||r?.actor_uuid!==base.actor_uuid||r.server_id!==task.server_id||!positive(r.revision)||r.revision<=task.revision)throw Error('Unconfirmed schedule result');refresh(base.actor_uuid);return r;
 }catch{if(token===getAccessToken())refresh(base.actor_uuid);throw Error('Schedule change could not be confirmed. Refresh and inspect before another attempt. No request was replayed.');}
 finally{clearTimeout(timer);pending.delete(base.actor_uuid);}
}
