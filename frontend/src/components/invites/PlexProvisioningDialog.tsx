import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { PlexJobReviewController, plexJobCanVerify, type PlexJobReviewState } from '../../lib/plexJobReview';

const phases: Record<string,string> = {not_started:'Not started',awaiting_acceptance:'Awaiting Plex acceptance',verification_required:'Accepted access needs verification',outcome_uncertain:'Share outcome uncertain',cleanup_uncertain:'Cleanup outcome uncertain',cleanup_recorded:'Cleanup recorded',review_required:'Review required',completed:'Local provisioning completed',cancelled:'Cancelled'};
const states: Record<string,string> = {prepared:'Not sent',send_uncertain:'Send outcome uncertain',awaiting_acceptance:'Awaiting acceptance',access_observed:'Accepted cloud access observed',cancel_uncertain:'Cleanup outcome uncertain',cancelled:'Cleanup recorded'};
export function PlexProvisioningDialog({jobId,onClose,onChanged}:{jobId:string;onClose:()=>void;onChanged:()=>Promise<void>}) {
 const [state,setState]=useState<PlexJobReviewState>({job:null,busy:true,canFinalize:false,error:null,notice:null});
 const [controller,setController]=useState<PlexJobReviewController|null>(null);
 const [reason,setReason]=useState('');
 const [risk,setRisk]=useState(false);
 const [activation,setActivation]=useState(false);
 useEffect(()=>{
  const c=new PlexJobReviewController(jobId,setState);setController(c);void c.reload();
  const timer=window.setInterval(()=>c.expire(),1000);
  return ()=>{window.clearInterval(timer);c.dispose();};
 },[jobId]);
 const job=state.job;
 const available=Boolean(job && plexJobCanVerify(job));
 const reasonBytes=new TextEncoder().encode(reason.trim()).length;
 const confirmed=reasonBytes>=10 && reasonBytes<=1000 && risk;
 const run=async(action:'verify'|'finalize')=>{
  if(!controller)return;
  const operation=controller.action(action,{reason,acknowledge_in_flight_risk:risk,acknowledge_local_activation:action==='finalize' && activation});
  setRisk(false);setActivation(false);
  await operation;
  if(!controller.state.busy)try{await onChanged();}catch{/* Receipt state remains independent from the invitation list. */}
 };
 return <ResponsiveDialog open onOpenChange={open=>{if(!open && !state.busy)onClose();}} title="Review Plex Provisioning" description="Review accepted library access before activating the recipient's local profile." contentClassName="max-w-3xl"
  footer={<>
   <Button variant="outline" onClick={onClose} disabled={state.busy}>Close</Button>
   <Button variant="outline" onClick={()=>{setRisk(false);setActivation(false);void controller?.reload();}} disabled={state.busy}>Refresh Receipt</Button>
   <Button variant="outline" onClick={()=>void run('verify')} disabled={state.busy || !available || !confirmed}>Verify Accepted Libraries</Button>
   <Button onClick={()=>void run('finalize')} disabled={state.busy || !state.canFinalize || !available || !confirmed || !activation}>Activate Local Profile</Button>
  </>}>
  <div className="space-y-4 text-sm">
   {state.error?<p className="text-destructive">{state.error}</p>:null}
   {state.notice?<p className="text-muted-foreground">{state.notice}</p>:null}
   {!job && state.busy?<p className="text-muted-foreground">Loading job...</p>:null}
   {job?<>
    <p className="font-mono break-all">{job.id} • {phases[job.plex_progress.phase]}</p>
    <p className="text-muted-foreground">{job.reservation_held?'Invitation capacity is reserved.':'Invitation capacity is no longer reserved.'} {job.plex_progress.operation_in_progress?'An operation is in progress. Refresh after it settles.':''}</p>
    <Table><TableHeader><TableRow><TableHead>Server</TableHead><TableHead>Recovery</TableHead></TableRow></TableHeader><TableBody>
     {job.steps.map(step=><TableRow key={step.server_id}><TableCell>#{step.server_id}</TableCell><TableCell>{step.plex?states[step.plex.state]:'Other provider; mixed jobs cannot use these controls'}{step.plex?.completion_recorded?<div className="text-xs text-muted-foreground">Completion recorded at {step.plex.verified_at}</div>:null}</TableCell></TableRow>)}
    </TableBody></Table>
    <p className="text-muted-foreground">Verification checks accepted selected libraries with downloads disabled on one Plex server. It records the cloud policy and recipient library listing at that time. It does not prove continuous playback or terminate existing sessions.</p>
    <p className="text-muted-foreground">Activation completes the job, consumes one invitation use, releases its reservation and enables the local profile with its original login credentials. Share sending and cleanup controls are unavailable here. Failed or uncertain jobs require further reconciliation.</p>
    <label className="space-y-1 block"><span>Review reason</span><Input value={reason} onChange={e=>setReason(e.target.value)} disabled={state.busy || !available} placeholder="Record what you checked (10–1000 bytes)" /></label>
    <label className="flex items-start gap-3"><Checkbox checked={risk} onCheckedChange={v=>setRisk(v===true)} disabled={state.busy || !available}/><span>I understand the selected-library verification scope and that outstanding provider work or later changes can alter access.</span></label>
    <label className="flex items-start gap-3"><Checkbox checked={activation} onCheckedChange={v=>setActivation(v===true)} disabled={state.busy || !state.canFinalize}/><span>I authorize local profile activation and completion of this invitation use.</span></label>
   </>:null}
  </div>
 </ResponsiveDialog>;
}
