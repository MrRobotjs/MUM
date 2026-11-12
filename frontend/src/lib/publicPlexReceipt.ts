export type PublicPlexReceipt = {
 id:string; status:'running'|'completed'|'failed'|'cancelled'; requires_review:boolean;
 plex_progress:{phase:string;requires_review:boolean;operation_in_progress:boolean;completion_available:false};
 steps:{server_id:number;status:string;stage:string;plex:{state:string;revision:number;operation_in_progress:boolean;reconciliation_required:boolean;access_verified:false;cleanup_scope:'none'|'owner_cloud_grant';completion_recorded?:true;verification_scope?:string;verified_at?:string}}[];
};
export type PublicReceiptCredentials={request_id:string;username:string;password:string};
export type PublicPlexReceiptState={phase:'idle'|'checking'|'prepared'|'awaiting_acceptance'|'verification_required'|'uncertain'|'review_required'|'cleanup_recorded'|'completed'|'cancelled'|'error';busy:boolean;receipt:PublicPlexReceipt|null;error:string|null};
const uuid=(v:unknown):v is string=>typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const scope='accepted_cloud_and_recipient_library_listing';
export function publicPlexReceipt(value:unknown,job:string,server:number):PublicPlexReceipt {
 const j=value as PublicPlexReceipt,p=j?.plex_progress,c=j?.steps?.[0]?.plex,s=j?.steps?.[0];
 if(!uuid(job) || !Number.isSafeInteger(server) || server<1 || !j || j.id!==job || !['running','completed','failed','cancelled'].includes(j.status) || typeof j.requires_review!=='boolean' || !Array.isArray(j.steps) || j.steps.length!==1 || !s || s.server_id!==server || !['pending','running','completed','failed'].includes(s.status) || !['pending','completed'].includes(s.stage) || !p || !['not_started','awaiting_acceptance','verification_required','outcome_uncertain','cleanup_uncertain','cleanup_recorded','review_required','completed','cancelled'].includes(p.phase) || typeof p.requires_review!=='boolean' || typeof p.operation_in_progress!=='boolean' || p.completion_available!==false || !c || !['prepared','awaiting_acceptance','access_observed','send_uncertain','cancel_uncertain','cancelled'].includes(c.state) || !Number.isSafeInteger(c.revision) || c.revision<1 || typeof c.operation_in_progress!=='boolean' || typeof c.reconciliation_required!=='boolean' || c.access_verified!==false || c.cleanup_scope!==(c.state==='cancelled'?'owner_cloud_grant':'none') || c.completion_recorded!==undefined && c.completion_recorded!==true)throw Error('Invalid public Plex receipt');
 if(j.requires_review!==(j.status==='failed' || p.requires_review) || p.operation_in_progress!==c.operation_in_progress || c.completion_recorded && (j.status!=='completed' || s.status!=='completed' || s.stage!=='completed' || c.state!=='access_observed' || c.verification_scope!==scope || typeof c.verified_at!=='string' || !Number.isFinite(Date.parse(c.verified_at))) || p.phase==='completed' && (j.status!=='completed' || j.requires_review || !c.completion_recorded || c.operation_in_progress))throw Error('Invalid public Plex completion');
 const expectedPhase:Record<string,string>={prepared:'not_started',awaiting_acceptance:'awaiting_acceptance',access_observed:'verification_required',send_uncertain:'outcome_uncertain',cancel_uncertain:'cleanup_uncertain',cancelled:j.status==='cancelled'?'cancelled':'cleanup_recorded'};
 if(j.status!=='completed' && p.phase!==expectedPhase[c.state] || j.status==='completed' && p.phase!=='completed' && p.phase!=='review_required')throw Error('Inconsistent public Plex phase');
 return {id:j.id,status:j.status,requires_review:j.requires_review,plex_progress:{phase:p.phase,requires_review:p.requires_review,operation_in_progress:p.operation_in_progress,completion_available:false},steps:[{server_id:s.server_id,status:s.status,stage:s.stage,plex:{state:c.state,revision:c.revision,operation_in_progress:c.operation_in_progress,reconciliation_required:c.reconciliation_required,access_verified:false,cleanup_scope:c.cleanup_scope,...(c.completion_recorded?{completion_recorded:true,verification_scope:scope,verified_at:c.verified_at}:{})}}]};
}

// Staged adapter only: the public wizard still rejects Plex capabilities. This
// controller can only read an existing credential-bound receipt, never redeem.
export class PublicPlexReceiptController {
 state:PublicPlexReceiptState={phase:'idle',busy:false,receipt:null,error:null};
 private disposed=false;
 private generation=0;
 private abort:AbortController|null=null;
 private checkpointRevision=0;
 private checkpointState='';
 private completionRecorded=false;
 constructor(private token:string,private job:string,private server:number,private changed:(state:PublicPlexReceiptState)=>void) {
  if(!/^[A-Za-z0-9_-]{43}$/.test(token) || !uuid(job) || !Number.isSafeInteger(server) || server<1)throw Error('Invalid Plex receipt reference');
 }
 private publish(next:Partial<PublicPlexReceiptState>){if(!this.disposed){this.state={...this.state,...next};this.changed(this.state);}}
 dispose(){this.disposed=true;this.generation++;this.abort?.abort();this.abort=null;this.token='';this.checkpointRevision=0;this.checkpointState='';this.completionRecorded=false;this.state={phase:'idle',busy:false,receipt:null,error:null};}
 async check(input:PublicReceiptCredentials){
  if(this.disposed || this.state.busy)return;
  const username=input.username.trim();
  if(typeof input.request_id!=='string' || input.request_id.length<32 || input.request_id.length>128 || !username || new TextEncoder().encode(username).length>255 || new TextEncoder().encode(input.password).length<12 || new TextEncoder().encode(input.password).length>1024){this.publish({phase:'error',receipt:null,error:'Enter the request reference and original local username/password.'});return;}
  const body=JSON.stringify({job_id:this.job,request_id:input.request_id,username,password:input.password});
  const run=++this.generation,abort=new AbortController();this.abort=abort;
  this.publish({phase:'checking',busy:true,receipt:null,error:null});
  try{
   const response=await fetch(`/api/public/invitations/${encodeURIComponent(this.token)}/receipt`,{method:'POST',credentials:'omit',mode:'same-origin',redirect:'error',cache:'no-store',headers:{Accept:'application/json','Content-Type':'application/json'},body,signal:abort.signal});
   if(!response.ok)throw Error('Receipt unavailable');
   const payload=await response.json();
   const receipt=publicPlexReceipt(payload?.data,this.job,this.server);
   if(this.disposed || run!==this.generation)return;
   const checkpoint=receipt.steps[0].plex;
   if(checkpoint.revision<this.checkpointRevision || checkpoint.revision===this.checkpointRevision && checkpoint.state!==this.checkpointState || this.completionRecorded && receipt.plex_progress.phase!=='completed')throw Error('Stale receipt');
   this.checkpointRevision=checkpoint.revision;this.checkpointState=checkpoint.state;
   this.completionRecorded=receipt.plex_progress.phase==='completed';
   const phase=receipt.plex_progress.phase;
   this.publish({receipt,phase:phase==='outcome_uncertain' || phase==='cleanup_uncertain'?'uncertain':receipt.status==='failed'?'review_required':phase==='not_started'?'prepared':phase as PublicPlexReceiptState['phase']});
  }catch{
   if(!this.disposed && run===this.generation)this.publish({phase:'error',receipt:null,error:'Could not confirm the receipt. Check the original reference and credentials, then explicitly check again. No provisioning action was sent.'});
  }finally{if(!this.disposed && run===this.generation){this.abort=null;this.publish({busy:false});}}
 }
}
