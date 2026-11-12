import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
export type EditAction = 'update_libraries'|'extend_access'|'set_expiration'|'clear_expiration'|'link_local'|'unlink_local'|'delete_users';
export type EditIntent = {action:EditAction;days?:number;expires_at?:string;library_ids?:string[];has_all_libraries?:boolean;target_local_user_uuid?:string};
export type EditReceipt = {id:string;revision:string;state:'prepared'|'running'|'completed'|'needs_review';action:EditAction;results:{uuid:string;outcome:string;reason:string}[];summary:Record<'updated'|'deleted'|'unchanged'|'skipped'|'failed'|'unknown'|'pending',number>;warnings:string[];effects:string[]};
// The library edit dialog keys its checkboxes by MUM's library row ID, but the
// server, like every other grant, expects the media server's own library ID.
// The two can be equal numbers for different libraries (Plex section keys are
// small integers), so each checked row is translated, never passed through.
export function editLibraryExternalIds(libraries:{id:string|number;external_id?:string|null}[],checks:Record<string,boolean>):string[]{
 const byRow=new Map(libraries.map(library=>[String(library.id),library]));
 return Object.keys(checks).filter(id=>checks[id]).map(id=>{
  const library=byRow.get(id);
  if(!library)throw Error('A selected library is no longer available. Reopen the dialog.');
  const external=String(library.external_id??'').trim();
  if(!external)throw Error('A selected library has no server ID. Sync the server and try again.');
  return external;
 });
}
export const editSummary=(r:EditReceipt)=>Object.entries(r.summary).map(([key,count])=>`${count} ${key}`).join(', ');
export class EditOperationsClient {
 private preparedSessions=new Map<string,string|null>();
 private dispatched=new Map<string,Promise<EditReceipt>>();
 private async request(path:string,body?:unknown):Promise<EditReceipt>{
  const token=getAccessToken();if(!token)throw Error('Administrator access is required.');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),30000);
  try{const response=await requestJson<{data:EditReceipt}>(path,{signal:abort.signal,retryAuthentication:false,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
   if(token!==getAccessToken())throw Error('Session changed. Reopen Edit.');
   const r=response.data;if(!r||typeof r.id!=='string'||typeof r.revision!=='string'||!Array.isArray(r.results)||!r.summary||!Array.isArray(r.warnings)||!Array.isArray(r.effects))throw Error('Invalid operation receipt. Refresh status.');return r;
  }finally{clearTimeout(timer);}
 }
 async prepare(user_uuids:string[],operation:EditIntent){const token=getAccessToken();const r=await this.request('/api/users/edit/prepare',{request_id:crypto.randomUUID(),user_uuids:[...user_uuids],operation});this.preparedSessions.set(r.id,token);return r;}
 read(id:string){return this.request(`/api/edit-operations/${encodeURIComponent(id)}`);}
 execute(r:EditReceipt){if(!this.preparedSessions.has(r.id)||this.preparedSessions.get(r.id)!==getAccessToken())return Promise.reject(Error('Session changed or operation recovered. Read status instead.'));const key=r.id+':'+r.revision;let pending=this.dispatched.get(key);if(!pending){pending=this.request(`/api/edit-operations/${encodeURIComponent(r.id)}/execute`,{revision:r.revision,acknowledge_effects:true});this.dispatched.set(key,pending);}return pending;}
 reconcile(r:EditReceipt){return this.request(`/api/edit-operations/${encodeURIComponent(r.id)}/reconcile`,{revision:r.revision});}
}
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
// One Apply Changes click (Flask-style dialog): prepare, run once, and read the
// result until it settles. An uncertain remote outcome gets one read-only
// reconciliation; nothing is ever sent twice. Gives up waiting (not the work)
// after about two minutes.
export async function runEditOperation(client:EditOperationsClient,ids:string[],intent:EditIntent,deadlineMs=120000):Promise<EditReceipt>{
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
 no_expiration:'no expiration date',plex_impact_too_large:'too many Plex shares are affected',plex_impact_unavailable:'Plex shares could not be read',protected_plex_impact:'it would remove Plex access of the owner or an administrator',
};
// Returns null when every selected user changed as asked, otherwise a short
// summary for an error toast (counts plus plain-language reasons).
export function editOutcomeMessage(receipts:EditReceipt[]):string|null{
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
export function savedEditIds(actor:string):string[]{try{const v=JSON.parse(localStorage.getItem(`mum.edit.${actor}`)||'[]');return Array.isArray(v)?v.filter(x=>typeof x==='string').slice(0,32):[];}catch{return [];}}
export function saveEditIds(actor:string,ids:string[]){try{localStorage.setItem(`mum.edit.${actor}`,JSON.stringify(ids.slice(0,32)));}catch{/* Status remains available in memory. */}}

export async function readEditReceipts(client:EditOperationsClient,ids:string[]){
 const reads=await Promise.allSettled([...new Set(ids)].map(id=>client.read(id)));
 const receipts:EditReceipt[]=[],missing:string[]=[];const errors:string[]=[];
 const unique=[...new Set(ids)];
 reads.forEach((result,i)=>{if(result.status==='fulfilled')receipts.push(result.value);else{missing.push(unique[i]);errors.push(`${unique[i]}: ${result.reason instanceof Error?result.reason.message:'Status unavailable'}`);}});
 return {receipts,missing,errors};
}

// Finishing review acknowledges definitive outcomes; the server journal remains intact.
export function canFinishEditReview(receipts:EditReceipt[],missingIds:string[]=[],recovering=false,statusError:string|null=null):boolean{
 if(!receipts.length||missingIds.length||recovering||statusError)return false;
 const definitive=new Set(['updated','deleted','unchanged','skipped','failed']);
 return receipts.every(r=>r.state==='prepared' ? r.summary.unknown===0&&r.results.every(row=>row.outcome==='pending'||definitive.has(row.outcome)) : (r.state==='completed'||r.state==='needs_review')&&r.summary.unknown===0&&r.summary.pending===0&&r.results.every(row=>definitive.has(row.outcome)));
}

// Extending or clearing applies only to users with an expiration date; the
// others keep unlimited access. The dialog reads the dates of every selected
// user (the selection can span pages) to say so before anything is applied.
export type EditExpiryOverview = {total:number;dated:number};

export async function readEditExpiry(ids:string[]):Promise<EditExpiryOverview>{
 const response=await requestJson<{data:{users:{uuid:string;access_expires_at:string|null}[]}}>('/api/users/edit/expiry',{method:'POST',body:JSON.stringify({user_uuids:ids})});
 const users=response.data.users;
 return {total:users.length,dated:users.filter(user=>user.access_expires_at!==null).length};
}

// Shown before Apply when only some selected users have an expiration date.
export function editExpiryNote(overview:EditExpiryOverview|null):string|null{
 if(!overview||overview.dated===0||overview.dated===overview.total)return null;
 const others=overview.total-overview.dated;
 return `Applies to ${overview.dated} of ${overview.total} selected users. The other ${others} ${others===1?'has':'have'} no expiration date and will be left as they are.`;
}

// The result once Apply finishes, counting users left alone for having no date.
export function editExpiryOutcome(done:string,receipts:EditReceipt[]):string{
 const plural=(count:number)=>`${count} user${count!==1?'s':''}`;
 let changed=0,undated=0;
 for(const r of receipts)for(const row of r.results){
  if(row.reason==='no_expiration')undated++;
  else if(row.outcome==='updated'||row.outcome==='unchanged')changed++;
 }
 return `${done} for ${plural(changed)}${undated?`; ${undated} skipped (no expiration date)`:''}`;
}
