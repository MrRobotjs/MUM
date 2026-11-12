import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';

export type MonitorTask = {
  server_id: string; server_name: string; provider: 'jellyfin' | 'emby' | 'plex'; revision: number; server_revision: number; enabled: boolean;
  socket_enabled:boolean;socket_state:string;socket_error:string;interval_seconds: number; state: string; last_code: string; next_run_at: string | null;
  started_at: string | null; finished_at: string | null; attempts: number;
};
export type MonitorSnapshot = {
  actor_uuid: string; configuration_available: boolean; runtime_available: boolean;
  checkpoint_error: boolean; tasks: MonitorTask[];
};
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const date = (value: unknown) => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

export async function fetchActivityMonitoring(actor: string, signal?: AbortSignal): Promise<MonitorSnapshot> {
  const token = getAccessToken();
  const {data: value} = await requestJson<{data: MonitorSnapshot}>('/api/settings/activity-monitoring', {retryAuthentication: false, signal});
  if (!token || token !== getAccessToken() || signal?.aborted || value?.actor_uuid !== actor ||
      typeof value.configuration_available !== 'boolean' || typeof value.runtime_available !== 'boolean' ||
      typeof value.checkpoint_error !== 'boolean' || !Array.isArray(value.tasks) || value.tasks.length > 1000) throw Error('Monitoring settings are unavailable. Refresh.');
  const seen = new Set<string>();
  const tasks: MonitorTask[] = [];
  for (const task of value.tasks) {
    if (!task || typeof task.server_name !== 'string' || !task.server_name.trim() || !['jellyfin', 'emby', 'plex'].includes(task.provider) || !id(task.server_id) || seen.has(task.server_id) || !positive(task.revision) ||
        !Number.isSafeInteger(task.server_revision) || task.server_revision < 0 || typeof task.enabled !== 'boolean' || typeof task.socket_enabled!=='boolean'||task.socket_enabled&&!task.enabled||!task.socket_enabled&&task.socket_state!=='disabled'||!['disabled','stopped','paused','waiting','connecting','connected','backoff','failed'].includes(task.socket_state)||!['','INVALID_SOURCE','TRANSPORT_FAILED','QUEUE_REJECTED','CHECKPOINT_FAILED','STATE_UNAVAILABLE'].includes(task.socket_error)||
        !Number.isSafeInteger(task.interval_seconds) || task.interval_seconds < 15 || task.interval_seconds > 3600 ||
        !['disabled', 'stopped', 'paused', 'scheduled', 'running', 'recovering'].includes(task.state) ||
        !['NEVER_RUN', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.last_code) ||
        !date(task.next_run_at) || !date(task.started_at) || !date(task.finished_at) ||
        !Number.isSafeInteger(task.attempts) || task.attempts < 0 ||
        (task.state === 'disabled' && task.enabled) || (task.state !== 'disabled' && !task.enabled) ||
        (task.state === 'scheduled' && task.next_run_at === null) ||
        (['running', 'recovering'].includes(task.state) && task.started_at === null)) throw Error('Invalid monitoring status. Refresh.');
    seen.add(task.server_id);
    tasks.push({server_id: task.server_id, server_name: task.server_name, provider: task.provider, revision: task.revision, server_revision: task.server_revision,
      enabled: task.enabled,socket_enabled:task.socket_enabled,socket_state:task.socket_state,socket_error:task.socket_error, interval_seconds: task.interval_seconds, state: task.state, last_code: task.last_code,
      next_run_at: task.next_run_at, started_at: task.started_at, finished_at: task.finished_at, attempts: task.attempts});
  }
  return {actor_uuid: actor, configuration_available: value.configuration_available, runtime_available: value.runtime_available,
    checkpoint_error: value.checkpoint_error, tasks};
}

export const MONITORING_EVENT = 'mum:activity-monitoring-changed';
function refresh(actor: string) {
  try { if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new CustomEvent(MONITORING_EVENT, {detail: {actor_uuid: actor}})); } catch { /* Optional read signal. */ }
}
const pending = new Set<string>();
export async function configureActivityMonitoring(base: MonitorSnapshot, task: MonitorTask, enabled: boolean, interval: number, consent: boolean, signal?: AbortSignal,sockets=task.socket_enabled) {
  if (!base.configuration_available || !base.tasks.some(row => row.server_id === task.server_id && row.revision === task.revision && row.server_revision === task.server_revision) ||
      typeof enabled !== 'boolean' || typeof sockets!=='boolean'||sockets&&!enabled|| !Number.isSafeInteger(interval) || interval < 15 || interval > 3600 || typeof consent !== 'boolean' || enabled && !consent || signal?.aborted) throw Error('Refresh owner monitoring settings and confirm visibility before enabling.');
  if (pending.has(base.actor_uuid)) throw Error('A monitoring change is pending.');
  pending.add(base.actor_uuid);
  const token = getAccessToken(), abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
  const cancel = () => abort.abort(); signal?.addEventListener('abort', cancel, {once: true});
  try {
    const fresh = await fetchActivityMonitoring(base.actor_uuid, abort.signal), current = fresh.tasks.find(row => row.server_id === task.server_id);
    if (!fresh.configuration_available || token !== getAccessToken() || abort.signal.aborted || current?.revision !== task.revision || current.server_revision !== task.server_revision) throw Error('Monitoring configuration changed');
    const {data: result} = await requestJson<{data: {actor_uuid: string; server_id: string; revision: number}}>(`/api/settings/activity-monitoring/${task.server_id}`, {
      method: 'PUT', retryAuthentication: false, signal: abort.signal,
      body: JSON.stringify({expected_actor_uuid: base.actor_uuid, revision: task.revision, server_revision: task.server_revision,
        enabled,socket_enabled:sockets, interval_seconds: interval, acknowledge_complete_session_visibility: consent}),
    });
    if (token !== getAccessToken() || abort.signal.aborted || result?.actor_uuid !== base.actor_uuid || result.server_id !== task.server_id || !positive(result.revision) || result.revision <= task.revision) throw Error('Unconfirmed monitoring result');
    refresh(base.actor_uuid); return result;
  } catch {
    if (token === getAccessToken()) refresh(base.actor_uuid);
    throw Error('Monitoring change could not be confirmed. Refresh and inspect before another attempt. No request was replayed.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); pending.delete(base.actor_uuid); }
}
