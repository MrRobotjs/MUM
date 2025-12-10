export type MessageType =
  | 'SessionStart'
  | 'SessionUpdate'
  | 'SessionStop'
  | 'MediaAdded'
  | 'MediaUpdated'
  | 'MediaRemoved'
  | 'LibraryScanStarted'
  | 'LibraryScanCompleted'
  | 'TaskStarted'
  | 'TaskProgress'
  | 'TaskCompleted'
  | 'ServerStatus'
  | 'Error';

export interface UnifiedEvent<TPayload = any> {
  channel: string;
  type: MessageType;
  source?: string | null;
  server_id?: number | null;
  payload: TPayload;
  timestamp: string;
}

export interface UnifiedSession {
  session_id: string;
  user: {
    name: string;
    uuid?: string | null;
    avatar?: string | null;
  };
  client: {
    name?: string | null;
    platform?: string | null;
    product?: string | null;
  };
  item: {
    title: string;
    type: string;
    library?: string | null;
    year?: string | number | null;
    thumb?: string | null;
    grandparent_title?: string | null;
    parent_title?: string | null;
  };
  server: {
    id?: number | null;
    name?: string | null;
    service: string;
  };
  state: string;
  playback: {
    progress: number;
    position_seconds?: number | null;
    duration_seconds?: number | null;
    position_text?: string | null;
    duration_text?: string | null;
  };
  quality?: {
    detail?: string | null;
    stream?: string | null;
    container?: string | null;
    video?: string | null;
    audio?: string | null;
    subtitle?: string | null;
    transcode_reason?: string | null;
    bitrate?: number | null;
    is_transcode?: boolean | null;
  };
  network?: {
    location?: string | null;
    ip?: string | null;
    is_public_ip?: boolean | null;
    bandwidth?: string | null;
  };
  raw?: string | null;
  original?: unknown;
}

export interface SessionUpdatePayload {
  active_count: number;
  sessions: UnifiedSession[];
  live_services?: string[];
  summary?: Record<string, unknown>;
}

export type SessionUpdateEvent = UnifiedEvent<SessionUpdatePayload>;
