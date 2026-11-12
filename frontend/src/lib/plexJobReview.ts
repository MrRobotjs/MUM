import { requestJson } from '../util/apiClient';
import { getAccessToken } from '../store/authStore';
import { fetchPersonalProfile } from './plexConnection';

export const plexJobVerificationScope = 'accepted_cloud_and_recipient_library_listing';
export type PlexJobStep = { server_id: number; plex?: { state: string; revision: number; operation_in_progress: boolean; reconciliation_required: boolean; access_verified: false; cleanup_scope: 'none' | 'owner_cloud_grant'; completion_recorded?: boolean; verification_scope?: string; verified_at?: string } };
export type PlexReviewJob = { id: string; status: string; revision: number; reservation_held: boolean; review_in_progress: boolean; steps: PlexJobStep[]; plex_progress: { phase: string; operation_in_progress: boolean; requires_review: boolean; completion_available: false } };
export type PlexJobDecision = { reason: string; acknowledge_in_flight_risk: boolean; acknowledge_local_activation: boolean };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;

// Copy only the documented receipt fields. Raw provider/job credentials never
// become controller state, including unknown fields from a malformed response.
export function plexReviewJob(value: unknown, expected: string): PlexReviewJob {
 const j = value as PlexReviewJob;
 const p = j?.plex_progress;
 if (!j || !uuid(j.id) || j.id !== expected || !positive(j.revision) || !['pending','running','failed','completed','cancelled'].includes(j.status) || typeof j.reservation_held !== 'boolean' || typeof j.review_in_progress !== 'boolean' || !Array.isArray(j.steps) || !j.steps.length || j.steps.length > 20 || new Set(j.steps.map(s=>s?.server_id)).size !== j.steps.length || !p || !['not_started','awaiting_acceptance','verification_required','outcome_uncertain','cleanup_uncertain','cleanup_recorded','review_required','completed','cancelled'].includes(p.phase) || typeof p.operation_in_progress !== 'boolean' || typeof p.requires_review !== 'boolean' || p.completion_available !== false) throw new Error('Invalid Plex job receipt');
 const steps = j.steps.map(s => {
  if (!s || !positive(s.server_id)) throw new Error('Invalid Plex server receipt');
  if (!s.plex) return {server_id:s.server_id};
  const c = s.plex;
  if (!positive(c.revision) || !['prepared','send_uncertain','awaiting_acceptance','access_observed','cancel_uncertain','cancelled'].includes(c.state) || typeof c.operation_in_progress !== 'boolean' || typeof c.reconciliation_required !== 'boolean' || c.access_verified !== false || c.cleanup_scope !== (c.state === 'cancelled' ? 'owner_cloud_grant' : 'none') || c.completion_recorded !== undefined && typeof c.completion_recorded !== 'boolean') throw new Error('Invalid Plex checkpoint receipt');
  if (c.completion_recorded && (c.state !== 'access_observed' || c.verification_scope !== plexJobVerificationScope || typeof c.verified_at !== 'string' || !Number.isFinite(Date.parse(c.verified_at)))) throw new Error('Invalid Plex completion receipt');
  return {server_id:s.server_id,plex:{state:c.state,revision:c.revision,operation_in_progress:c.operation_in_progress,reconciliation_required:c.reconciliation_required,access_verified:false as const,cleanup_scope:c.cleanup_scope,...(c.completion_recorded ? {completion_recorded:true,verification_scope:plexJobVerificationScope,verified_at:c.verified_at} : {})}};
 });
 if (!steps.some(s=>s.plex) || p.phase === 'completed' && (j.status !== 'completed' || j.reservation_held || steps.some(s=>!s.plex?.completion_recorded))) throw new Error('Invalid Plex completion receipt');
 return {id:j.id,status:j.status,revision:j.revision,reservation_held:j.reservation_held,review_in_progress:j.review_in_progress,steps,plex_progress:{phase:p.phase,operation_in_progress:p.operation_in_progress,requires_review:p.requires_review,completion_available:false}};
}
export async function fetchPlexJob(id: string) {
 if (!uuid(id)) throw new Error('Invalid Plex job');
 const {data} = await requestJson<{data:unknown}>(`/api/provisioning-jobs/${encodeURIComponent(id)}`);
 return plexReviewJob(data,id);
}
export function plexJobCanVerify(j: PlexReviewJob) {
 const c = j.steps[0]?.plex;
 return j.status === 'running' && j.reservation_held && !j.review_in_progress && !j.plex_progress.operation_in_progress && j.steps.length === 1 && Boolean(c && !c.operation_in_progress && !c.reconciliation_required && !c.completion_recorded && ['awaiting_acceptance','access_observed'].includes(c.state));
}
export function plexJobActionPayload(job: PlexReviewJob, action: 'verify'|'finalize', decision: PlexJobDecision) {
 const j = plexReviewJob(job,job.id);
 const length = new TextEncoder().encode(decision.reason.trim()).length;
 if (!['verify','finalize'].includes(action) || !plexJobCanVerify(j)) throw new Error('This Plex job is not available for verification or activation');
 if (length < 10 || length > 1000 || decision.acknowledge_in_flight_risk !== true || decision.acknowledge_local_activation !== (action === 'finalize')) throw new Error('Enter a reason of 10–1000 bytes and confirm the scope and activation choice');
 return {job_revision:j.revision,checkpoint_revision:j.steps[0].plex!.revision,reason:decision.reason.trim(),verification_scope:plexJobVerificationScope,acknowledge_in_flight_risk:true,acknowledge_local_activation:action === 'finalize'};
}
export type PlexJobReviewState = { job: PlexReviewJob | null; busy: boolean; canFinalize: boolean; error: string | null; notice: string | null };
export class PlexJobReviewController {
 state: PlexJobReviewState = {job:null,busy:false,canFinalize:false,error:null,notice:null};
 private disposed = false;
 private generation = 0;
 private actor: string | null = null;
 private verifiedUntil = 0;
 constructor(private id: string, private changed: (state:PlexJobReviewState)=>void, private now = ()=>Date.now()) {}
 private publish(next: Partial<PlexJobReviewState>) {if (!this.disposed) {this.state={...this.state,...next};this.changed(this.state);}}
 private valid(run:number, token:string|null) {return !this.disposed && run === this.generation && token === getAccessToken();}
 dispose() {this.disposed=true;this.generation++;this.verifiedUntil=0;this.state={...this.state,job:null,canFinalize:false};}
 expire() {if (this.state.canFinalize && this.now() >= this.verifiedUntil) this.publish({canFinalize:false,notice:'Verification expired. Verify the accepted libraries again before activation.'});}
 private async currentActor() {
  const p = await fetchPersonalProfile();
  if (this.actor && this.actor !== p.uuid) throw new Error('The signed-in account changed. Reopen this job.');
  this.actor = p.uuid;
 }
 async reload() {
  if (this.disposed || this.state.busy) return;
  const run=++this.generation;
  this.publish({job:null,busy:true,canFinalize:false,error:null,notice:null});this.verifiedUntil=0;
  try {
   await this.currentActor();const token=getAccessToken();
   const job=await fetchPlexJob(this.id);
   if(this.valid(run,token))this.publish({job});
   else if(!this.disposed && run===this.generation)this.publish({error:'Your session changed. Refresh the receipt.'});
  } catch {if(!this.disposed && run===this.generation)this.publish({job:null,error:'Could not read the current Plex receipt. Check your session and refresh.'});}
  finally {if(!this.disposed && run===this.generation)this.publish({busy:false});}
 }
 async action(action:'verify'|'finalize', decision:PlexJobDecision) {
  if(this.disposed || this.state.busy || !this.state.job)return;
  this.expire();
  if(action==='finalize' && !this.state.canFinalize){this.publish({error:'Verify accepted libraries before activating this profile.'});return;}
  let body: ReturnType<typeof plexJobActionPayload>;
  try {body=plexJobActionPayload(this.state.job,action,decision);}catch(e){this.publish({error:(e as Error).message});return;}
  const job=this.state.job, run=++this.generation, started=this.now();
  const token=getAccessToken();
  this.publish({busy:true,canFinalize:false,error:null,notice:null});this.verifiedUntil=0;
  let sent=false;
  try {
   await this.currentActor();
   if(!this.valid(run,token))return;
   sent=true;
   const response=await requestJson<{data:unknown}>(`/api/provisioning-jobs/${encodeURIComponent(job.id)}/plex/${job.steps[0].server_id}/${action}`,{method:'POST',body:JSON.stringify(body),retryAuthentication:false});
   const result=plexReviewJob(response.data,job.id);
   const refreshed=await fetchPlexJob(job.id);
   if(!this.valid(run,token))return;
   const same = refreshed.revision===result.revision && refreshed.steps[0]?.plex?.revision===result.steps[0]?.plex?.revision;
   if(action==='finalize' && refreshed.plex_progress.phase!=='completed')throw new Error('Completion not confirmed');
   const ready=action==='verify' && same && result.revision===job.revision && (result.steps[0]?.plex?.revision ?? 0)>job.steps[0].plex!.revision && plexJobCanVerify(refreshed) && refreshed.steps[0].plex?.state==='access_observed' && this.now()<started+60000;
   this.verifiedUntil=ready ? started+60000 : 0;
   this.publish({job:refreshed,canFinalize:ready,notice:action==='finalize'?'Local profile activated. Original login credentials are unchanged.':ready?'Accepted selected libraries verified. Confirm local activation within one minute.':'Receipt changed. Read and verify again before activation.'});
  }catch{
   if(!this.valid(run,token))return;
   this.publish({job:null,error:sent?'The action could not be confirmed. Refresh the receipt before another action; no request was replayed.':'Could not confirm the current administrator. Refresh the receipt.'});
   if(sent)try{const refreshed=await fetchPlexJob(job.id);if(this.valid(run,token))this.publish({job:refreshed});}catch{/* Keep all actions disabled until an explicit successful read. */}
  }finally{
   if(!this.disposed && run===this.generation){if(token!==getAccessToken())this.publish({job:null,canFinalize:false,error:'Your session changed. Refresh the receipt before another action.'});this.publish({busy:false});}
  }
 }
}
