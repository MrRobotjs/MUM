import {requestJson,ApiError} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';

export type ServerSyncScope='users'|'libraries';
export type ServerSyncReceipt={server_id:number;source_revision:number;revision:number;scope:ServerSyncScope;libraries:number;users:number;added:number;updated:number;removed:number};
const pending=new Set<string>();
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
export async function syncSelectedServer(id:number,revision:number,scope:ServerSyncScope,current:()=>boolean,signal?:AbortSignal):Promise<ServerSyncReceipt>{
 const token=getAccessToken();
 if(!token||!current()||!Number.isSafeInteger(id)||id<1||!count(revision)||revision>=Number.MAX_SAFE_INTEGER||!['users','libraries'].includes(scope)||signal?.aborted)throw Error('Select a current server before synchronizing.');
 const key=`${token}:${id}`;if(pending.has(key))throw Error('A server synchronization is already pending.');pending.add(key);
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),25000),cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});
 try{
  const {data:d}=await requestJson<{data:ServerSyncReceipt}>(`/api/servers/${id}/sync-${scope}`,{method:'POST',retryAuthentication:false,signal:abort.signal,body:JSON.stringify({expected_server_revision:revision})});
  if(abort.signal.aborted||token!==getAccessToken()||!current()||!d||d.server_id!==id||d.source_revision!==revision||d.revision!==revision+1||d.scope!==scope||![d.libraries,d.users,d.added,d.updated,d.removed].every(count)||scope==='libraries'&&(d.users!==0||d.added!==0||d.updated!==0||d.removed!==0)||scope==='users'&&d.libraries!==0)throw Error('Unconfirmed synchronization receipt.');
  return {server_id:id,source_revision:revision,revision:d.revision,scope,libraries:d.libraries,users:d.users,added:d.added,updated:d.updated,removed:d.removed};
 }catch(e){
  if(e instanceof ApiError&&[400,401,403,404,409].includes(e.status))throw Error('Synchronization was refused. Refresh the server before another attempt.');
  if(e instanceof ApiError&&e.status===502)throw Error('Provider synchronization failed; the previous snapshot was retained. Refresh before another attempt.');
  throw Error('Synchronization outcome is unconfirmed. Refresh and inspect saved data before another attempt. No request was replayed.');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);pending.delete(key);}
}
