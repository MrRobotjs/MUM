export type ActiveSession = {
  // Basic identifiers
  session_key: string;
  user: string;
  user_avatar_url?: string;
  mum_user_id?: number;
  mum_user_uuid?: string;

  // Media info
  media_title: string;
  grandparent_title?: string;
  parent_title?: string;
  edition?: string;
  media_type: string;
  library_name: string;
  year?: string;
  thumb_url?: string;

  // Server info
  service_type: string;
  server_name: string;

  // Player info
  player_title?: string;
  player_platform?: string;
  product?: string;
  state: string;

  // Progress
  progress: number;
  current_time: string;
  duration: string;

  // Quality and streaming details
  quality_detail: string;
  stream_detail: string;
  container_detail?: string;
  video_detail?: string;
  audio_detail?: string;
  subtitle_detail?: string;
  transcode_reason?: string;

  // Location
  location_detail: string;
  location_ip?: string;
  is_public_ip?: boolean;
  bandwidth_detail?: string;

  // Raw data for debugging
  raw_data_json?: string;

  // Calculated fields for statistics
  bitrate_calc?: number;
  location_type_calc?: string;
  is_transcode_calc?: boolean;
  transcode_speed?: number;
  transcode_throttled?: boolean;
  source?: 'ws' | 'http';
};

export type ActiveSessionsMeta = {
  request_id?: string;
  timestamp?: string;
} & Record<string, unknown>;

export type ActiveSessionsResponse = {
  sessions: ActiveSession[];
  total_count: number;
  by_server?: Record<string, ActiveSession[]>;
  by_service?: Record<string, ActiveSession[]>;
  meta?: ActiveSessionsMeta;
};

export type ViewMode = 'merged' | 'categorized' | 'service';

export type PluginMetaResponse = {
  data: Record<
    string,
    {
      features?: string[];
    }
  >;
};
