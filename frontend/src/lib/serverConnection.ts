import {requestJson,ApiError} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';

export type ServerCheckReceipt={server_id:number;revision:number;checked_at:string;name:string;version:string};
const pending=new Set<string>();
export async function checkServerConnection(id:number,revision:number,current:()=>boolean,signal?:AbortSignal):Promise<ServerCheckReceipt>{
 const token=getAccessToken();
 if(!token||!current()||!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(revision)||revision<0||signal?.aborted)throw Error('Select a current server before testing.');
 const key=`${token}:${id}`;if(pending.has(key))throw Error('A connection test is already pending.');
 pending.add(key);
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000),cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});
 try{
  const {data:d}=await requestJson<{data:{success:boolean;server_id:number;revision:number;checked_at:string;server:{name:string;version?:string}}}>(`/api/servers/${id}/test-connection`,{method:'POST',retryAuthentication:false,signal:abort.signal,body:JSON.stringify({expected_server_revision:revision})});
  if(abort.signal.aborted||token!==getAccessToken()||!current()||!d||d.success!==true||d.server_id!==id||d.revision!==revision||typeof d.checked_at!=='string'||!Number.isFinite(Date.parse(d.checked_at))||!d.server||typeof d.server.name!=='string'||d.server.name.length>1024||d.server.version!==undefined&&typeof d.server.version!=='string')throw Error('Unconfirmed connection test.');
  return {server_id:id,revision,checked_at:d.checked_at,name:d.server.name,version:d.server.version??''};
 }catch(e){
  if(e instanceof ApiError&&e.status===502)throw Error('The provider connection check failed. Refresh saved status before another test.');
  if(e instanceof ApiError&&[400,401,403,404,409].includes(e.status))throw Error('The connection test was refused. Refresh the server before another test.');
  throw Error('The connection test outcome is unconfirmed. Refresh saved status before another test. No request was replayed.');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);pending.delete(key);}
}
