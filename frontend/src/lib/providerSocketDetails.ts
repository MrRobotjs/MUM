import type {MonitorTask} from './activityMonitoring';

export function isSocketConnected(task:MonitorTask):boolean {
  return (task.state === 'scheduled' || task.state === 'running') && task.socket_state === 'connected';
}

export function scheduledTaskState(state:string):'active'|'inactive'|'unavailable' {
  if (state === 'scheduled' || state === 'running') return 'active';
  if (state === 'disabled' || state === 'stopped' || state === 'paused') return 'inactive';
  return 'unavailable';
}

export function socketMonitoringStatus(task:MonitorTask):string {
  if (task.state === 'disabled') return 'Disabled';
  if (task.state === 'stopped') return 'Stopped';
  if (task.state === 'paused') return 'Unavailable';
  if (task.state === 'recovering') return 'Recovering';
  if (task.socket_state === 'connected') return 'Active · WebSocket';
  if (task.state === 'scheduled' || task.state === 'running') return 'HTTP fallback';
  return 'Unavailable';
}

export function providerSocketSubscriptions(task:MonitorTask):{subscription:string;events:string[]} {
  if (task.provider === 'plex') return {subscription:'Plex provides a notification stream; it does not use a separate channel subscription here.',events:['playing','timeline','activity','transcodeSession.start','transcodeSession.end']};
  return {subscription:'MUM requests session updates every 5 seconds with SessionsStart; it does not verify a subscription acknowledgement.',events:['Sessions','SessionStart','SessionEnded','PlaybackStart','PlaybackStopped','PlaybackProgress']};
}
