import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
export type Notification={id:number;timestamp:string;notification_type:'SERVER_NOT_SYNCED'|'ACCOUNT_EXPIRED'|'SERVICE_EXPIRED';title:string;message:string;read:boolean;resolved:boolean;details?:Record<string,unknown>};
export type NotificationSnapshot={actor_uuid:string;content_revision:number;inbox_revision:number;notifications:Notification[];total:number;unread_count:number};
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
export const NOTIFICATIONS_EVENT='mum:notifications-changed';
function refresh(actor:string){try{if(typeof window!=='undefined'&&window.dispatchEvent)window.dispatchEvent(new CustomEvent(NOTIFICATIONS_EVENT,{detail:{actor_uuid:actor}}));}catch{/* Read invalidation is optional. */}}
export async function fetchNotifications(actor:string,signal?:AbortSignal):Promise<NotificationSnapshot>{
 const token=getAccessToken(),items:Notification[]=[];let after:number|null=null,base:NotificationSnapshot|null=null;
 for(let page=0;page<100;page++){
  const{data:p}=await requestJson<{data:NotificationSnapshot&{next_after:number|null}}>(`/api/notifications${after===null?'':`?after=${after}`}`,{retryAuthentication:false,signal});
  if(!token||token!==getAccessToken()||signal?.aborted||!p||p.actor_uuid!==actor||!integer(p.content_revision)||!integer(p.inbox_revision)||!Number.isSafeInteger(p.total)||p.total<0||p.total>10000||!Number.isSafeInteger(p.unread_count)||p.unread_count<0||p.unread_count>p.total||!Array.isArray(p.notifications)||p.notifications.length>100||p.next_after!==null&&!integer(p.next_after)||base&&(p.content_revision!==base.content_revision||p.inbox_revision!==base.inbox_revision||p.total!==base.total||p.unread_count!==base.unread_count))throw Error('Notification inbox changed or is incomplete. Refresh.');
  base={actor_uuid:actor,content_revision:p.content_revision,inbox_revision:p.inbox_revision,total:p.total,unread_count:p.unread_count,notifications:items};
  for(const n of p.notifications){if(!n||!integer(n.id)||items.length&&n.id>=items[items.length-1].id||after!==null&&n.id>=after||typeof n.timestamp!=='string'||!Number.isFinite(Date.parse(n.timestamp))||!['SERVER_NOT_SYNCED','ACCOUNT_EXPIRED','SERVICE_EXPIRED'].includes(n.notification_type)||typeof n.title!=='string'||n.title.length>255||typeof n.message!=='string'||n.message.length>4096||typeof n.read!=='boolean'||typeof n.resolved!=='boolean'||n.resolved&&!n.read)throw Error('Invalid notification record');items.push({id:n.id,timestamp:n.timestamp,notification_type:n.notification_type,title:n.title,message:n.message,read:n.read,resolved:n.resolved});}
  if(p.next_after===null){if(items.length!==p.total||items.filter(n=>!n.read).length!==p.unread_count)throw Error('Incomplete notification inbox');return base;}
  if(p.notifications.length!==100||p.next_after!==p.notifications[99].id)throw Error('Invalid notification cursor');after=p.next_after;
 }
 throw Error('Notification inbox exceeds its complete-read limit');
}
const pending=new Set<string>();
export async function changeNotifications(base:NotificationSnapshot,operation:'read'|'read_all'|'dismiss',ids:number[]=[]){
 if(!['read','read_all','dismiss'].includes(operation)||!integer(base.content_revision)||!integer(base.inbox_revision)||operation==='read_all'&&(ids.length!==0||!base.unread_count)||operation!=='read_all'&&(!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>!integer(id)||!base.notifications.some(n=>n.id===id&&(operation==='dismiss'||!n.read)))))throw Error('Refresh the exact notification targets first.');
 if(pending.has(base.actor_uuid))throw Error('A notification change is pending.');pending.add(base.actor_uuid);
 const token=getAccessToken(),abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000),selected=[...ids];
 try{
  const fresh=await fetchNotifications(base.actor_uuid,abort.signal);
  if(fresh.content_revision!==base.content_revision||fresh.inbox_revision!==base.inbox_revision||token!==getAccessToken())throw Error('Inbox changed');
  const expected=operation==='read_all'?base.notifications.filter(n=>!n.read).map(n=>n.id).sort((a,b)=>a-b):selected;
  const{data:r}=await requestJson<{data:{actor_uuid:string;content_revision:number;inbox_revision:number;operation:string;notification_ids:number[]}}>('/api/notifications/state',{method:'POST',retryAuthentication:false,signal:abort.signal,body:JSON.stringify({expected_actor_uuid:base.actor_uuid,content_revision:base.content_revision,inbox_revision:base.inbox_revision,operation,notification_ids:selected})});
  if(token!==getAccessToken()||abort.signal.aborted||r?.actor_uuid!==base.actor_uuid||r.content_revision!==base.content_revision||!integer(r.inbox_revision)||r.inbox_revision<=base.inbox_revision||r.operation!==operation||!Array.isArray(r.notification_ids)||r.notification_ids.length!==expected.length||r.notification_ids.some((id,i)=>id!==expected[i]))throw Error('Unconfirmed inbox outcome');
  refresh(base.actor_uuid);return r;
 }catch{if(token===getAccessToken())refresh(base.actor_uuid);throw Error('Notification change could not be confirmed. Refresh and inspect the inbox before another attempt. No request was replayed.');}
 finally{clearTimeout(timer);pending.delete(base.actor_uuid);}
}
