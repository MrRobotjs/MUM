import { requestJson } from '../util/apiClient';
import { getAccessToken } from '../store/authStore';

export type RuntimeInfo = {
  actor_uuid: string; go_version: string; platform: string; timezone: string; timezone_offset_seconds: number;
  database_type: 'SQLite'; database_version: string; database_file: string | null; data_directory: string | null;
  log_storage: string; build_revision: string | null; build_modified: boolean | null;
};
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
export async function fetchRuntimeInfo(actor: string): Promise<RuntimeInfo> {
  const token = getAccessToken();
  if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(actor)) throw Error('Administrator access is required.');
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
  try {
    const { data: d } = await requestJson<{data: RuntimeInfo}>('/api/settings/runtime-info', { signal: abort.signal, retryAuthentication: false });
    if (token !== getAccessToken() || !d || d.actor_uuid !== actor || !text(d.go_version, 128) || !text(d.platform, 64) || !text(d.timezone, 128) || !Number.isInteger(d.timezone_offset_seconds) || Math.abs(d.timezone_offset_seconds) > 86400 || d.database_type !== 'SQLite' || !text(d.database_version, 64) || !text(d.log_storage) || d.database_file !== null && !text(d.database_file, 32768) || d.data_directory !== null && !text(d.data_directory, 32768) || (d.database_file === null) !== (d.data_directory === null) || d.build_revision !== null && !/^[0-9a-f]{7,64}$/.test(d.build_revision) || d.build_modified !== null && typeof d.build_modified !== 'boolean') throw Error('Runtime information is unavailable. Refresh.');
    return { actor_uuid: actor, go_version: d.go_version, platform: d.platform, timezone: d.timezone, timezone_offset_seconds: d.timezone_offset_seconds,
      database_type: d.database_type, database_version: d.database_version, database_file: d.database_file, data_directory: d.data_directory,
      log_storage: d.log_storage, build_revision: d.build_revision, build_modified: d.build_modified };
  } finally { clearTimeout(timer); }
}
