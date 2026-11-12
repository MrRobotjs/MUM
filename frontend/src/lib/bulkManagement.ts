import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
export type BulkAction = 'update_libraries'|'extend_access'|'set_expiration'|'clear_expiration'|'link_local'|'unlink_local'|'delete_users';
export type BulkIntent = {action:BulkAction;days?:number;expires_at?:string;library_ids?:string[];has_all_libraries?:boolean;target_local_user_uuid?:string};
export type BulkReceipt = {id:string;revision:string;state:'prepared'|'running'|'completed'|'needs_review';action:BulkAction;results:{uuid:string;outcome:string;reason:string}[];summary:Record<'updated'|'deleted'|'unchanged'|'skipped'|'failed'|'unknown'|'pending',number>;warnings:string[];effects:string[]};
export const bulkSummary=(r:BulkReceipt)=>Object.entries(r.summary).map(([key,count])=>`${count} ${key}`).join(', ');
export class BulkManagementClient {
 private preparedSessions=new Map<string,string|null>();
 private dispatched=new Map<string,Promise<BulkReceipt>>();
 private async request(path:string,body?:unknown):Promise<BulkReceipt>{
  const token=getAccessToken();if(!token)throw Error('Administrator access is required.');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),30000);
  try{const response=await requestJson<{data:BulkReceipt}>(path,{signal:abort.signal,retryAuthentication:false,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
   if(token!==getAccessToken())throw Error('Session changed. Reopen bulk management.');
   const r=response.data;if(!r||typeof r.id!=='string'||typeof r.revision!=='string'||!Array.isArray(r.results)||!r.summary||!Array.isArray(r.warnings)||!Array.isArray(r.effects))throw Error('Invalid operation receipt. Refresh status.');return r;
  }finally{clearTimeout(timer);}
 }
 async prepare(user_uuids:string[],operation:BulkIntent){const token=getAccessToken();const r=await this.request('/api/users/bulk/prepare',{request_id:crypto.randomUUID(),user_uuids:[...user_uuids],operation});this.preparedSessions.set(r.id,token);return r;}
 read(id:string){return this.request(`/api/bulk-operations/${encodeURIComponent(id)}`);}
 execute(r:BulkReceipt){if(!this.preparedSessions.has(r.id)||this.preparedSessions.get(r.id)!==getAccessToken())return Promise.reject(Error('Session changed or operation recovered. Read status instead.'));const key=r.id+':'+r.revision;let pending=this.dispatched.get(key);if(!pending){pending=this.request(`/api/bulk-operations/${encodeURIComponent(r.id)}/execute`,{revision:r.revision,acknowledge_effects:true});this.dispatched.set(key,pending);}return pending;}
 reconcile(r:BulkReceipt){return this.request(`/api/bulk-operations/${encodeURIComponent(r.id)}/reconcile`,{revision:r.revision});}
}
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
// One Apply Changes click (Flask-style dialog): prepare, run once, and read the
// result until it settles. An uncertain remote outcome gets one read-only
// reconciliation; nothing is ever sent twice. Gives up waiting (not the work)
// after about two minutes.
export async function runBulkOperation(client:BulkManagementClient,ids:string[],intent:BulkIntent,deadlineMs=120000):Promise<BulkReceipt>{
 let r=await client.prepare(ids,intent);
 if(r.state==='prepared'&&r.summary.pending>0)r=await client.execute(r);
 const stop=Date.now()+deadlineMs;let reconciled=false;let delay=500;
 while(Date.now()<stop){
  if(r.state==='needs_review'&&r.summary.unknown>0&&!reconciled){reconciled=true;r=await client.reconcile(r);continue;}
  if(r.state!=='running')return r;
  await wait(delay);delay=Math.min(delay*2,4000);
  r=await client.read(r.id);
 }
 return r;
}

const reasonLabels:Record<string,string>={
 protected_owner:'the owner account',protected_self:'your own account',administrator:'administrators',protected_account:'the owner or an administrator',
 owner_only:'only the owner can change service accounts',pending_work:'another change is still running on that server',invite_in_progress:'an invitation is being processed',
 plex_connection:'a connected personal Plex account',already_deleted:'already deleted',not_found:'no longer exists',unsupported:'not supported by that server',
 unavailable:'not available',server_unavailable:'the server is unavailable',service_only:'service accounts only',service_account_required:'service accounts only',
 not_primary_owner:'not linked to that local account',link_unavailable:'linking is not possible',provider_rejected:'the server refused the change',
 provider_inspection_failed:'the server could not be read',provider_not_verified:'the server did not confirm the change',remote_outcome_uncertain:'the server result is uncertain',
 interrupted_before_dispatch:'interrupted before it was sent',plex_dynamic_all_unsupported:'Plex cannot switch this user to all libraries',
 plex_impact_too_large:'too many Plex shares are affected',plex_impact_unavailable:'Plex shares could not be read',protected_plex_impact:'it would remove Plex access of the owner or an administrator',
};
// Returns null when every selected user changed as asked, otherwise a short
// summary for an error toast (counts plus plain-language reasons).
export function bulkOutcomeMessage(receipts:BulkReceipt[]):string|null{
 const total={updated:0,deleted:0,unchanged:0,skipped:0,failed:0,unknown:0,pending:0};
 const reasons=new Set<string>();let running=false;
 for(const r of receipts){
  if(r.state==='running')running=true;
  for(const key of Object.keys(total) as (keyof typeof total)[])total[key]+=r.summary[key]??0;
  for(const row of r.results)if(row.reason&&!['updated','deleted','unchanged'].includes(row.outcome))reasons.add(reasonLabels[row.reason]??row.reason.replace(/_/g,' '));
 }
 if(!running&&!total.skipped&&!total.failed&&!total.unknown&&!total.pending)return null;
 const done=total.updated+total.deleted+total.unchanged;
 const parts=[`${done} done`];
 if(total.skipped)parts.push(`${total.skipped} skipped`);
 if(total.failed)parts.push(`${total.failed} failed`);
 if(total.unknown)parts.push(`${total.unknown} uncertain (check the server before retrying)`);
 if(running||total.pending)parts.push('some changes are still running; refresh the page later');
 return `${parts.join(', ')}.${reasons.size?` Reasons: ${[...reasons].join('; ')}.`:''}`;
}

// Only opaque receipt IDs are persisted, separated by the authenticated actor.
export function savedBulkIds(actor:string):string[]{try{const v=JSON.parse(localStorage.getItem(`mum.bulk.${actor}`)||'[]');return Array.isArray(v)?v.filter(x=>typeof x==='string').slice(0,32):[];}catch{return [];}}
export function saveBulkIds(actor:string,ids:string[]){try{localStorage.setItem(`mum.bulk.${actor}`,JSON.stringify(ids.slice(0,32)));}catch{/* Status remains available in memory. */}}

export async function readBulkReceipts(client:BulkManagementClient,ids:string[]){
 const reads=await Promise.allSettled([...new Set(ids)].map(id=>client.read(id)));
 const receipts:BulkReceipt[]=[],missing:string[]=[];const errors:string[]=[];
 const unique=[...new Set(ids)];
 reads.forEach((result,i)=>{if(result.status==='fulfilled')receipts.push(result.value);else{missing.push(unique[i]);errors.push(`${unique[i]}: ${result.reason instanceof Error?result.reason.message:'Status unavailable'}`);}});
 return {receipts,missing,errors};
}

// Finishing review acknowledges definitive outcomes; the server journal remains intact.
export function canFinishBulkReview(receipts:BulkReceipt[],missingIds:string[]=[],recovering=false,statusError:string|null=null):boolean{
 if(!receipts.length||missingIds.length||recovering||statusError)return false;
 const definitive=new Set(['updated','deleted','unchanged','skipped','failed']);
 return receipts.every(r=>r.state==='prepared' ? r.summary.unknown===0&&r.results.every(row=>row.outcome==='pending'||definitive.has(row.outcome)) : (r.state==='completed'||r.state==='needs_review')&&r.summary.unknown===0&&r.summary.pending===0&&r.results.every(row=>definitive.has(row.outcome)));
}
