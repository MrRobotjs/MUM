import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { useAlerts } from '../../contexts/AlertContext';
import { fetchProvisioningReceipt, fetchProvisioningReview, submitProvisioningReview, submitProvisioningResume, type ProvisioningReviewJob } from '../../lib/provisioningReview';
import type { PlexReviewJob } from '../../lib/plexJobReview';
import { PlexProvisioningDialog } from './PlexProvisioningDialog';

const cleanupLabels: Record<string, string> = { pending: 'Not checked', running: 'Checking', disabled: 'Disabled (verified)', absent: 'Absent (verified)', not_started: 'Not started', manual: 'Resolved externally by administrator', failed: 'Verification failed', unknown: 'Needs external review' };
const resumeLabels: Record<string, string> = { pending: '', running: 'Resumption in progress', completed: 'Resumption verified', failed: 'Resumption failed', unknown: 'Resumption outcome needs review' };

export function ProvisioningReviewDialog({ jobId, onClose, onChanged }: { jobId: string | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const { error: showError, success } = useAlerts();
  const [job, setJob] = useState<ProvisioningReviewJob | null>(null);
  const [plexJob, setPlexJob] = useState<PlexReviewJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [releaseUsername, setReleaseUsername] = useState(false);
  const [manual, setManual] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
	const [passwords, setPasswords] = useState<Record<number, string>>({});
	const [confirmPasswords, setConfirmPasswords] = useState<Record<number, string>>({});
	const [acknowledgePasswords, setAcknowledgePasswords] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    const current = ++revision.current;
    setJob(null); setPlexJob(null); setError(null); setBusy(false); setReason(''); setManual({}); setAcknowledge(false); setReleaseUsername(false);
		setPasswords({}); setConfirmPasswords({}); setAcknowledgePasswords(false);
    if (jobId) void fetchProvisioningReceipt(jobId).then(result => { if (revision.current === current) { if ('plex_progress' in result) setPlexJob(result); else setJob(result); } }).catch(e => { if (revision.current === current) setError((e as Error).message); });
    return () => { ++revision.current; };
  }, [jobId]);

  const run = async (action: 'disable-accounts' | 'cancel' | 'resume') => {
    if (!job || pending.current) return;
    const current = revision.current;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = action === 'resume' ? await submitProvisioningResume(job, { reason, acknowledge_in_flight_risk: acknowledge, acknowledge_password_changes: acknowledgePasswords,
        server_passwords: job.steps.map(step => ({ server_id: step.server_id, password: passwords[step.server_id] ?? '', confirm_password: confirmPasswords[step.server_id] ?? '' })) }) : await submitProvisioningReview(job, action, { reason, acknowledge_in_flight_risk: acknowledge, release_username: releaseUsername,
        manual_resolutions: Object.entries(manual).filter(([id, text]) => text.trim() && job.steps.some(s => s.server_id === Number(id) && s.manual_resolution_allowed)).map(([id, text]) => ({ server_id: Number(id), reason: text })) });
      if (revision.current !== current) return;
      if (action === 'resume') { setPasswords({}); setConfirmPasswords({}); setAcknowledgePasswords(false); }
      // Mutation responses are followed by a fresh read so manual-resolution
      // flags always reflect the current configuration, never a stale dialog.
      const refreshed = await fetchProvisioningReview(result.id);
      if (revision.current !== current) return;
      setJob(refreshed);
      success(result.status === 'completed' ? 'Original job completed. Share the new server passwords with the recipient; the local login password is unchanged.' : result.status === 'cancelled' ? 'Job cancelled; reservation released. History retained.' : result.review_error_code ? 'Review recorded; some outcomes still need reconciliation.' : 'Recorded access is disabled, revoked or absent at the time checked.');
      await onChanged();
    } catch (e) {
      if (revision.current !== current) return;
      const message = (e as Error).message;
      setError(message); showError(message);
      try { const result = await fetchProvisioningReview(job.id); if (revision.current === current) { setJob(result); await onChanged(); } } catch { /* Keep the original failure visible; never replay the mutation. */ }
    } finally { pending.current = false; if (revision.current === current) { setBusy(false); if (action === 'resume') { setPasswords({}); setConfirmPasswords({}); setAcknowledgePasswords(false); } } }
  };
  const available = job?.status === 'failed' && job.reservation_held && !job.review_in_progress;
  if (plexJob && plexJob.id === jobId) return <PlexProvisioningDialog key={jobId} jobId={plexJob.id} onClose={onClose} onChanged={onChanged} />;

  return <ResponsiveDialog open={Boolean(jobId)} onOpenChange={open => { if (!open && !busy) onClose(); }} title="Review Provisioning" description="Reconcile upstream access before releasing this invitation reservation." contentClassName="max-w-3xl"
    footer={<>
      <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
      <Button variant="outline" onClick={() => void run('disable-accounts')} disabled={!available || busy || !acknowledge}>{job?.steps.some(step => step.cleanup_scope === 'media') ? 'Revoke Recorded Access' : 'Disable Recorded Accounts'}</Button>
      <Button onClick={() => void run('cancel')} disabled={!available || busy || !acknowledge}>Cancel & Release Reservation</Button>
      <Button onClick={() => void run('resume')} disabled={!job?.resume_available || busy || !acknowledge || !acknowledgePasswords}>Resume & Set Server Passwords</Button>
    </>}>
    <div className="space-y-4 text-sm">
      {error ? <p className="text-destructive">{error}</p> : null}
      {!job && !error ? <p className="text-muted-foreground">Loading job...</p> : null}
      {job ? <>
        <p className="font-mono break-all">{job.id} • {job.status}</p>
        {job.steps.some(step => step.cleanup_scope === 'media') ? <p className="text-muted-foreground">Komga cleanup removes reading/download roles and library shares. Login and existing sessions may remain available.</p> : null}
        {job.review_in_progress ? <p className="text-muted-foreground">Another review is in progress. Close and reopen this dialog to refresh its result.</p> : null}
        <Table><TableHeader><TableRow><TableHead>Server</TableHead><TableHead>Account</TableHead><TableHead>Recovery</TableHead></TableRow></TableHeader><TableBody>
          {job.steps.map(step => <TableRow key={step.server_id}><TableCell>#{step.server_id}</TableCell><TableCell><div>{step.remote_username || 'Unknown'}</div><div className="text-xs text-muted-foreground break-all">{step.remote_id || 'No recorded remote ID'}</div></TableCell><TableCell>{step.cleanup_state === 'disabled' && step.cleanup_scope === 'media' ? 'Media access revoked (verified)' : cleanupLabels[step.cleanup_state]}{step.cleanup_error_code ? ' • Reconciliation required' : ''}{step.resume_state !== 'pending' ? <div className="text-xs text-muted-foreground">{resumeLabels[step.resume_state]}</div> : null}</TableCell></TableRow>)}
        </TableBody></Table>
        <p className="text-muted-foreground">Disabled and absent results are point-in-time checks. A provider request that timed out may still finish later. Unknown identities and changed server configurations require external reconciliation; this action does not guess ownership or delete accounts.</p>
        {job.steps.filter(step => step.manual_resolution_allowed).map(step => <label className="space-y-1 block" key={step.server_id}>
          <span>External resolution for server #{step.server_id}{step.manual_resolution_required ? ' (required)' : ' (optional after failed verification)'}</span>
          <Input value={manual[step.server_id] ?? ''} onChange={event => setManual(previous => ({ ...previous, [step.server_id]: event.target.value }))} disabled={busy || !available} placeholder="Describe how you confirmed remote effects are absent or revoked" />
        </label>)}
        <label className="space-y-1 block"><span>Review reason</span><Input value={reason} onChange={event => setReason(event.target.value)} disabled={busy || !available} placeholder="Record what you checked (10–1000 bytes)" /></label>
        {job.resume_available ? <div className="space-y-4">
          <p className="text-muted-foreground">Resumption uses only recorded identities and reapplies the original grants. It sets new passwords on every selected server and enables the local profile only after all servers succeed. The local login password remains unchanged.</p>
          {job.steps.map(step => <div key={step.server_id} className="space-y-2">
            <label className="space-y-1 block"><span>New server #{step.server_id} password (12–{step.password_max_bytes} bytes{step.password_ascii_only ? ", printable ASCII" : ""})</span><Input type="password" autoComplete="new-password" value={passwords[step.server_id] ?? ''} disabled={busy} onChange={event => setPasswords(previous => ({ ...previous, [step.server_id]: event.target.value }))} /></label>
            <label className="space-y-1 block"><span>Confirm server #{step.server_id} password</span><Input type="password" autoComplete="new-password" value={confirmPasswords[step.server_id] ?? ''} disabled={busy} onChange={event => setConfirmPasswords(previous => ({ ...previous, [step.server_id]: event.target.value }))} /></label>
          </div>)}
          <label className="flex items-start gap-3"><Checkbox checked={acknowledgePasswords} onCheckedChange={value => setAcknowledgePasswords(value === true)} disabled={busy} /><span>I authorize these server password changes and will provide the new credentials to the recipient.</span></label>
        </div> : null}
        <label className="flex items-start gap-3"><Checkbox checked={acknowledge} onCheckedChange={value => setAcknowledge(value === true)} disabled={busy || !available} /><span>I reconciled uncertain provider requests and understand that outstanding upstream work or later changes can restore access.</span></label>
        <label className="flex items-start gap-3"><Checkbox checked={releaseUsername} onCheckedChange={value => setReleaseUsername(value === true)} disabled={busy || !available} /><span>Also release the provisional local username. The inactive profile, receipts and service history remain. Remote accounts and usernames are not deleted.</span></label>
      </> : null}
    </div>
  </ResponsiveDialog>;
}
