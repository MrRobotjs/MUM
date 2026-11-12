import { requestJson } from '../util/apiClient';
import { plexReviewJob, type PlexReviewJob } from './plexJobReview';

export type ProvisioningReviewStep = {
  server_id: number; password_max_bytes: number; password_ascii_only: boolean; status: string; stage: string; remote_id?: string; remote_username?: string;
  cleanup_state: string; cleanup_scope: 'account' | 'media'; cleanup_error_code?: string; cleanup_checked_at?: string; manual_resolution_required: boolean; manual_resolution_allowed: boolean;
	resume_state: string; resume_error_code?: string;
};
export type ProvisioningReviewJob = {
  id: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; revision: number;
  invite_id: number; reservation_held: boolean; review_in_progress: boolean; review_error_code?: string;
  steps: ProvisioningReviewStep[];
	resume_available: boolean;
};
export type ReviewDecision = { reason: string; acknowledge_in_flight_risk: boolean; release_username: boolean; manual_resolutions: { server_id: number; reason: string }[] };

function reviewJob(value: unknown): ProvisioningReviewJob {
  const j = value as ProvisioningReviewJob;
  if (j && typeof j === 'object' && 'plex_progress' in j) throw new Error('Plex recovery controls are not available yet.');
  if (!j || typeof j.id !== 'string' || !Number.isSafeInteger(j.revision) || j.revision < 1 ||
      !['running', 'completed', 'failed', 'cancelled'].includes(j.status) || typeof j.reservation_held !== 'boolean' ||
      typeof j.review_in_progress !== 'boolean' || typeof j.resume_available !== 'boolean' || !Array.isArray(j.steps) || j.steps.length < 1 || j.steps.length > 20 ||
      new Set(j.steps.map(s => s.server_id)).size !== j.steps.length || j.steps.some(s => !Number.isSafeInteger(s.server_id) || s.server_id < 1 || ![72, 256, 1024].includes(s.password_max_bytes) || typeof s.password_ascii_only !== 'boolean' || typeof s.stage !== 'string' || !['account','media'].includes(s.cleanup_scope) || typeof s.manual_resolution_required !== 'boolean' || typeof s.manual_resolution_allowed !== 'boolean' || !['pending','running','completed','failed','unknown'].includes(s.resume_state) || !['pending','running','disabled','absent','not_started','manual','failed','unknown'].includes(s.cleanup_state))) throw new Error('Invalid provisioning review response');
  return j;
}

export type ResumeDecision = { reason: string; acknowledge_in_flight_risk: boolean; acknowledge_password_changes: boolean; server_passwords: { server_id: number; password: string; confirm_password: string }[] };

export function resumeDecisionPayload(job: ProvisioningReviewJob, decision: ResumeDecision) {
  if ('plex_progress' in job) throw new Error('Plex recovery controls are not available yet.');
  const length = new TextEncoder().encode(decision.reason.trim()).length;
  if (!job.resume_available || job.status !== 'failed' || !job.reservation_held || job.review_in_progress) throw new Error('This job cannot resume its recorded accounts');
  if (length < 10 || length > 1000 || !decision.acknowledge_in_flight_risk || !decision.acknowledge_password_changes) throw new Error('Enter a review reason and acknowledge upstream risk and server password changes');
  const expected = new Set(job.steps.map(step => step.server_id));
  const seen = new Set<number>();
  const passwords = decision.server_passwords.map(entry => {
    const bytes = new TextEncoder().encode(entry.password).length;
    const maximum = job.steps.find(step => step.server_id === entry.server_id)?.password_max_bytes;
    if (!expected.has(entry.server_id) || seen.has(entry.server_id) || bytes < 12 || maximum === undefined || ![72, 256, 1024].includes(maximum) || bytes > maximum || entry.password !== entry.confirm_password) throw new Error('Provide matching passwords within each recorded server’s displayed byte limits');
    if (job.steps.find(step => step.server_id === entry.server_id)?.password_ascii_only && (!/^[\x20-\x7e]{12,72}$/.test(entry.password) || !entry.password.trim())) throw new Error('This server requires 12–72 printable ASCII bytes');
    seen.add(entry.server_id);
    return { server_id: entry.server_id, password: entry.password };
  });
  if (seen.size !== expected.size) throw new Error('Every recorded server needs an explicit password');
  return { revision: job.revision, reason: decision.reason.trim(), acknowledge_in_flight_risk: true, acknowledge_password_changes: true, server_passwords: passwords };
}

export async function submitProvisioningResume(job: ProvisioningReviewJob, decision: ResumeDecision) {
  const response = await requestJson<{ data: unknown }>(`/api/provisioning-jobs/${encodeURIComponent(job.id)}/resume`, { method: 'POST', body: JSON.stringify(resumeDecisionPayload(job, decision)), retryAuthentication: false });
  const result = reviewJob(response.data);
  if (result.id !== job.id) throw new Error('Unexpected provisioning job');
  return result;
}

export async function fetchProvisioningReview(id: string): Promise<ProvisioningReviewJob> {
  const response = await requestJson<{ data: unknown }>(`/api/provisioning-jobs/${encodeURIComponent(id)}`);
  const job = reviewJob(response.data);
  if (job.id !== id) throw new Error('Unexpected provisioning job');
  return job;
}

export async function fetchProvisioningReceipt(id: string): Promise<ProvisioningReviewJob | PlexReviewJob> {
  const response = await requestJson<{ data: unknown }>(`/api/provisioning-jobs/${encodeURIComponent(id)}`);
  if (response.data && typeof response.data === 'object' && 'plex_progress' in response.data) return plexReviewJob(response.data, id);
  const job = reviewJob(response.data);
  if (job.id !== id) throw new Error('Unexpected provisioning job');
  return job;
}

export function reviewDecisionPayload(job: ProvisioningReviewJob, action: 'disable-accounts' | 'cancel', decision: ReviewDecision) {
  if ('plex_progress' in job) throw new Error('Plex recovery controls are not available yet.');
  const length = new TextEncoder().encode(decision.reason.trim()).length;
  if (job.status !== 'failed' || !job.reservation_held || job.review_in_progress) throw new Error('This job is not available for review');
  if (length < 10 || length > 1000 || !decision.acknowledge_in_flight_risk) throw new Error('Enter a reason of 10–1000 bytes and acknowledge uncertain provider outcomes');
  const required = new Set(job.steps.filter(s => s.manual_resolution_required).map(s => s.server_id));
	const allowed = new Set(job.steps.filter(s => s.manual_resolution_allowed).map(s => s.server_id));
  const seen = new Set<number>();
  const manual = action === 'cancel' ? decision.manual_resolutions.map(r => {
    const reason = r.reason.trim();
    const bytes = new TextEncoder().encode(reason).length;
    if (!allowed.has(r.server_id) || seen.has(r.server_id) || bytes < 10 || bytes > 1000) throw new Error('Record a specific external resolution for each uncertain server');
    seen.add(r.server_id);
    return { server_id: r.server_id, reason };
  }) : [];
  if (action === 'cancel' && [...required].some(id => !seen.has(id))) throw new Error('Every uncertain server needs an external resolution before cancellation');
  return { revision: job.revision, reason: decision.reason.trim(), acknowledge_in_flight_risk: true,
    ...(action === 'cancel' ? { release_username: decision.release_username, manual_resolutions: manual } : {}) };
}

export async function submitProvisioningReview(job: ProvisioningReviewJob, action: 'disable-accounts' | 'cancel', decision: ReviewDecision) {
  const payload = reviewDecisionPayload(job, action, decision);
  const response = await requestJson<{ data: unknown }>(`/api/provisioning-jobs/${encodeURIComponent(job.id)}/${action}`, { method: 'POST', body: JSON.stringify(payload), retryAuthentication: false });
  const result = reviewJob(response.data);
  if (result.id !== job.id) throw new Error('Unexpected provisioning job');
  return result;
}
