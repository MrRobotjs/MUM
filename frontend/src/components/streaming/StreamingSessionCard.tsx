import type { ReactNode, MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { requestJson } from '@/util/apiClient';
import { useAlerts } from '@/contexts/AlertContext';
import { getServiceIconClass, getServiceMeta } from '@/config/pluginMetadata';
import { useAdminApi } from '@/hooks/useAdminApi';
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { buildUserProfilePath } from '@/util/routes';

const StreamInfoDialog = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Stream Details"
      description="Understanding playback methods and server status"
    >
      <div className="space-y-4 text-sm">
        <div className="space-y-3">
          <div className="rounded-lg border p-3 border-green-500/20 bg-green-500/5">
            <div className="font-semibold text-green-500 mb-1 flex items-center gap-2">
              <i className="fa-solid fa-play-circle" /> Direct Play
            </div>
            <p className="text-muted-foreground">
              The player handles the file natively. Best quality, near-zero server CPU usage.
            </p>
          </div>

          <div className="rounded-lg border p-3 border-green-500/20 bg-green-500/5">
            <div className="font-semibold text-green-400 mb-1 flex items-center gap-2">
              <i className="fa-solid fa-file-export" /> Direct Stream
            </div>
            <p className="text-muted-foreground">
              The video/audio streams are compatible, but the container (file format) is not.
              The server repackages it on-the-fly. Very low CPU usage.
            </p>
          </div>

          <div className="rounded-lg border p-3 border-amber-500/20 bg-amber-500/5">
            <div className="font-semibold text-amber-500 mb-1 flex items-center gap-2">
              <i className="fa-solid fa-gears" /> Transcode
            </div>
            <p className="text-muted-foreground mb-2">
              The server is converting video or audio on-the-fly. High CPU/GPU usage.
            </p>
            <div className="grid grid-cols-1 gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium text-amber-400">Active:</span>
                <span className="opacity-80">Server is currently processing segments.</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-green-500">Throttled:</span>
                <span className="opacity-80">Buffer is full, server is resting (Good).</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-blue-500">Speed:</span>
                <span className="opacity-80">Conversion speed vs playback (1.0 = Realtime).</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ResponsiveDialog>
  );
};

type ActiveSession = {
  session_key: string;
  user: string;
  user_avatar_url?: string;
  mum_user_id?: number;
  mum_user_uuid?: string;
  media_title: string;
  grandparent_title?: string;
  parent_title?: string;
  media_type: string;
  library_name: string;
  year?: string;
  thumb_url?: string;
  service_type: string;
  server_name: string;
  player_title?: string;
  player_platform?: string;
  product?: string;
  state: string;
  progress: number;
  current_time: string;
  duration: string;
  quality_detail: string;
  stream_detail: string;
  container_detail?: string;
  video_detail?: string;
  audio_detail?: string;
  subtitle_detail?: string;
  transcode_reason?: string;
  location_detail: string;
  location_ip?: string;
  is_public_ip?: boolean;
  bandwidth_detail?: string;
  raw_data_json?: string;
  bitrate_calc?: number;
  location_type_calc?: string;
  is_transcode_calc?: boolean;
  transcode_speed?: number;
  transcode_throttled?: boolean;
};

interface StreamingSessionCardProps {
  session: ActiveSession;
  onTerminate: (session: ActiveSession) => void;
}

const getStateColor = (state?: string) => {
  const normalized = state?.toLowerCase();
  if (normalized === 'playing' || normalized === 'listening') return 'text-green-500 bg-green-500';
  if (normalized === 'paused') return 'text-amber-500 bg-amber-500';
  if (normalized === 'buffering') return 'text-blue-500 bg-blue-500';
  return 'text-gray-500 bg-gray-500';
};

type PluginMetaResponse = {
  data: Record<
    string,
    {
      features?: string[];
    }
  >;
};

type JellyfinRawSession = {
  UserId?: string;
  PlayState?: { AudioStreamIndex?: number };
  NowPlayingItem?: {
    MediaStreams?: Array<{
      Type?: string;
      Index?: number;
      Codec?: string;
      Channels?: number;
      ChannelLayout?: string;
    }>;
  };
  TranscodingInfo?: {
    AudioCodec?: string;
    AudioChannels?: number;
    IsAudioDirect?: boolean;
  };
};

const normalizeChannels = (channelLayout?: string, channels?: number) => {
  if (channelLayout && channelLayout.trim()) return channelLayout.trim();
  if (!channels || !Number.isFinite(channels)) return undefined;
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  if (channels === 2) return '2.0';
  if (channels === 1) return '1.0';
  return `${channels}ch`;
};

const formatCodecAndChannels = (codec?: string, channelLayout?: string, channels?: number) => {
  const normalizedCodec = codec?.trim();
  if (!normalizedCodec) return undefined;
  const codecLabel = normalizedCodec.toUpperCase();
  const channelsLabel = normalizeChannels(channelLayout, channels);
  return channelsLabel ? `${codecLabel} ${channelsLabel}` : codecLabel;
};

const tryBuildJellyfinAudioTranscodeLabel = (rawDataJson?: string) => {
  if (!rawDataJson) return undefined;
  try {
    const parsed = JSON.parse(rawDataJson) as unknown;
    const sessionObject: JellyfinRawSession | undefined =
      typeof parsed === 'object' && parsed !== null && 'Data' in (parsed as Record<string, unknown>)
        ? (((parsed as { Data?: unknown[] }).Data?.[0] as JellyfinRawSession | undefined) ?? undefined)
        : (parsed as JellyfinRawSession);

    if (!sessionObject) return undefined;

    const audioStreamIndex = sessionObject.PlayState?.AudioStreamIndex;
    const mediaStreams = sessionObject.NowPlayingItem?.MediaStreams ?? [];
    const audioStreams = mediaStreams.filter((s) => (s.Type ?? '').toLowerCase() === 'audio');
    const sourceStream =
      (audioStreamIndex !== undefined ? audioStreams.find((s) => s.Index === audioStreamIndex) : undefined) ??
      audioStreams[0];

    const source = formatCodecAndChannels(sourceStream?.Codec, sourceStream?.ChannelLayout, sourceStream?.Channels);
    const target = formatCodecAndChannels(
      sessionObject.TranscodingInfo?.AudioCodec,
      undefined,
      sessionObject.TranscodingInfo?.AudioChannels
    );

    if (source && target) return `${source} -> ${target}`;
    return source ?? target;
  } catch {
    return undefined;
  }
};

const tryExtractJellyfinUserId = (rawDataJson?: string) => {
  if (!rawDataJson) return undefined;
  try {
    const parsed = JSON.parse(rawDataJson) as unknown;
    const sessionObject: JellyfinRawSession | undefined =
      typeof parsed === 'object' && parsed !== null && 'Data' in (parsed as Record<string, unknown>)
        ? (((parsed as { Data?: unknown[] }).Data?.[0] as JellyfinRawSession | undefined) ?? undefined)
        : (parsed as JellyfinRawSession);
    const userId = sessionObject?.UserId;
    return typeof userId === 'string' && userId.trim() ? userId.trim() : undefined;
  } catch {
    return undefined;
  }
};

export const StreamingSessionCard = ({ session, onTerminate }: StreamingSessionCardProps) => {
  const [showStreamInfo, setShowStreamInfo] = useState(false);
  const [showSendMessage, setShowSendMessage] = useState(false);
  const [sendMessageText, setSendMessageText] = useState('');
  const [sendMessageHeader, setSendMessageHeader] = useState('MUM');
  const [sendMessageTimeoutSeconds, setSendMessageTimeoutSeconds] = useState<string>('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const { data: pluginMetaData } = useAdminApi<PluginMetaResponse>('/plugins/metadata', true);
  const navigate = useNavigate();
  const normalizedState = session.state?.toLowerCase();
  const stateColor = getStateColor(session.state);
  const streamDetailLower = (session.stream_detail ?? '').toLowerCase();
  const isTranscoding = streamDetailLower.includes('transcode') || session.is_transcode_calc;
  const directMethodLabel = streamDetailLower.includes('direct play')
    ? 'Direct Play'
    : streamDetailLower.includes('direct stream')
      ? 'Direct Stream'
      : 'Direct Play';
  const normalizedServiceType = (session.service_type ?? '').toLowerCase();
  const serviceMeta = getServiceMeta(session.service_type);
  const supportsSessionMessage = Boolean(
    normalizedServiceType &&
    pluginMetaData?.data?.[normalizedServiceType]?.features?.includes('session_message')
  );

  const jellyfinAudioTranscodeLabel =
    normalizedServiceType === 'jellyfin' ? tryBuildJellyfinAudioTranscodeLabel(session.raw_data_json) : undefined;
  const resolvedAudioDetail =
    session.audio_detail && !session.audio_detail.toLowerCase().includes('unknown audio')
      ? session.audio_detail
      : jellyfinAudioTranscodeLabel ?? session.audio_detail;
  const { success, error: showError } = useAlerts();
  const canNavigateToUserProfile = Boolean(session.mum_user_uuid?.trim());
  const avatarBgClass = serviceMeta.palette?.avatar ?? 'bg-muted-foreground/20';
  const avatarTextClass = serviceMeta.palette?.avatar ? 'text-white' : 'text-muted-foreground';

  const handleUserProfileClick = async (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const uuid = session.mum_user_uuid?.trim();
    if (!uuid) {
      showError('User profile not available for this session.');
      return;
    }

    const expectedExternalId =
      normalizedServiceType === 'jellyfin' ? tryExtractJellyfinUserId(session.raw_data_json) : undefined;

    if (expectedExternalId) {
      try {
        const response = await requestJson<{ data?: { external_user_id?: string | null; external_user_alt_id?: string | null } }>(
          `/admin/api/v2/users/${uuid}`
        );
        const externalUserId = response?.data?.external_user_id ? String(response.data.external_user_id) : null;
        const externalUserAltId = response?.data?.external_user_alt_id ? String(response.data.external_user_alt_id) : null;
        const matches = expectedExternalId === externalUserId || expectedExternalId === externalUserAltId;
        if (!matches) {
          showError('Session user ID did not match the linked service user for this profile.');
          return;
        }
      } catch (error) {
        showError('Failed to verify user profile: ' + String(error));
        return;
      }
    }

    navigate({ to: buildUserProfilePath({ uuid, username: session.user, server_nickname: session.server_name }) });
  };

  const handleSendMessage = async () => {
    const text = sendMessageText.trim();
    if (!text) {
      showError('Message cannot be empty');
      return;
    }

    const header = sendMessageHeader.trim();
    const timeoutParsed = sendMessageTimeoutSeconds.trim()
      ? Number(sendMessageTimeoutSeconds.trim())
      : null;
    const timeoutSeconds =
      timeoutParsed && Number.isFinite(timeoutParsed) && timeoutParsed > 0
        ? timeoutParsed
        : null;

    try {
      setSendingMessage(true);
      await requestJson('/admin/api/v2/streaming/message', {
        method: 'POST',
        body: JSON.stringify({
          session_key: session.session_key,
          service_type: session.service_type,
          server_name: session.server_name,
          text,
          header: header || undefined,
          timeout_seconds: timeoutSeconds ?? undefined,
        }),
      });
      success(`Message sent to ${session.user}`);
      setShowSendMessage(false);
      setSendMessageText('');
      setSendMessageHeader('MUM');
      setSendMessageTimeoutSeconds('');
    } catch (error) {
      showError('Failed to send message: ' + String(error));
    } finally {
      setSendingMessage(false);
    }
  };

  // Format remaining time if possible, otherwise use duration
  // Simple heuristic: if we have current_time and duration as strings like "0:05", it's hard to calc remaining without parsing.
  // For now, we'll display the progress text as is or clean it up.
  // The image shows "16 min left". We don't have that pre-calculated in props,
  // but we can show "X% completed" or just the state.
  // Let's stick to what we have in data or simple display.

  return (
    <div
      className={`group relative flex h-full flex-col overflow-hidden rounded-xl bg-card shadow-lg transition-all duration-300 hover:shadow-xl sm:rounded-2xl border border-border/50`}
    >
      {/* Background Gradient & Border Helper */}
      <div className={`absolute inset-0 ${serviceMeta.streamingGradient ?? 'bg-gradient-to-br via-card to-card from-muted/50'} pointer-events-none`} />

      {/* Main Content Container */}
      <div className="relative z-10 flex h-full flex-col text-card-foreground">

        {/* --- Header Section: Poster + Title --- */}
        <div className="flex gap-4 p-4 pb-3">
          {/* Poster */}
          <div className="relative h-24 w-16 shrink-0 overflow-hidden rounded-md bg-muted shadow-md sm:h-32 sm:w-24">
            {session.thumb_url ? (
              <img
                src={session.thumb_url}
                alt={session.media_title}
                className="h-full w-full object-cover opacity-90 transition-opacity hover:opacity-100"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                <i className="fa-solid fa-image fa-lg" />
              </div>
            )}

            {/* Play/Pause Overlay Icon on Poster */}
            <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
              {normalizedState === 'paused' && <i className="fa-solid fa-pause text-2xl text-white/90 drop-shadow-md" />}
              {normalizedState === 'playing' && <i className="fa-solid fa-play text-2xl text-white/90 drop-shadow-md" />}
              {normalizedState === 'buffering' && <i className="fa-solid fa-circle-notch fa-spin text-2xl text-white/90 drop-shadow-md" />}
            </div>
          </div>

          {/* Title Info */}
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            <h3 className="line-clamp-2 text-lg font-bold leading-tight text-card-foreground sm:text-xl">
              {session.media_title}
            </h3>

            <div className="flex flex-col text-sm text-muted-foreground sm:text-base">
              {session.grandparent_title && (
                <span className="truncate opacity-90">{session.grandparent_title} {session.parent_title ? `— ${session.parent_title}` : ''}</span>
              )}
              <div className="flex items-center gap-2 text-xs text-muted-foreground/80 sm:text-sm">
                {session.year && <span>{session.year}</span>}
                {session.media_type && (
                  <>
                    <span className="text-muted-foreground/60">•</span>
                    <span className="capitalize">{session.media_type}</span>
                  </>
                )}
                {/* Terminate Button - Desktop Position (Absolute top right of card normally, but here let's keep it accessible) */}
              </div>
            </div>
          </div>

          {/* Terminate Action (Dropdown) */}
          <div className="absolute top-3 right-3 text-white">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <i className="fa-solid fa-ellipsis-vertical" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Session Controls</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {supportsSessionMessage && (
                  <DropdownMenuItem
                    onClick={() => {
                      setSendMessageText('');
                      setSendMessageHeader('MUM');
                      setSendMessageTimeoutSeconds('');
                      setShowSendMessage(true);
                    }}
                  >
                    <i className="fa-solid fa-message mr-2" />
                    Send Message
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => onTerminate(session)}
                  className="text-red-600 focus:text-red-600 focus:bg-red-100 dark:focus:bg-red-900/20"
                >
                  <i className="fa-solid fa-ban mr-2" />
                  Terminate Stream
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <ResponsiveDialog
          open={showSendMessage}
          onOpenChange={(value) => {
            if (!value) setShowSendMessage(false);
          }}
          title="Send Message"
          description={`Send a message to ${session.user}'s player.`}
          contentClassName="max-w-lg"
          footer={[
            <Button
              key="cancel"
              variant="outline"
              onClick={() => setShowSendMessage(false)}
              disabled={sendingMessage}
            >
              Cancel
            </Button>,
            <Button
              key="send"
              onClick={handleSendMessage}
              disabled={sendingMessage || !sendMessageText.trim()}
              className="gap-2"
            >
              <i className="fa-solid fa-paper-plane" />
              Send
            </Button>,
          ]}
        >
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">Header</label>
                <Input
                  value={sendMessageHeader}
                  onChange={(e) => setSendMessageHeader(e.target.value)}
                  placeholder="MUM"
                  disabled={sendingMessage}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">Timeout (seconds)</label>
                <Input
                  type="number"
                  min={1}
                  step={0.1}
                  value={sendMessageTimeoutSeconds}
                  onChange={(e) => setSendMessageTimeoutSeconds(e.target.value)}
                  placeholder="e.g. 5"
                  disabled={sendingMessage}
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">
                Message <span className="text-destructive">*</span>
              </label>
              <Textarea
                rows={4}
                placeholder="Type your message…"
                value={sendMessageText}
                onChange={(e) => setSendMessageText(e.target.value)}
                className="resize-none"
                required
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Supported for Jellyfin/Emby sessions.
            </p>
          </div>
        </ResponsiveDialog>

        {/* --- Progress Bar --- */}
        {/* Progress Header with State, Time, and Percentage */}
        <div className="flex items-center justify-between bg-transparent px-4 py-1.5 backdrop-blur-sm text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className={`${stateColor.split(' ')[0]}`}>
              {normalizedState === 'playing' ? <i className="fa-solid fa-play mr-1" /> : null}
              {normalizedState === 'paused' ? <i className="fa-solid fa-pause mr-1" /> : null}
              {normalizedState === 'buffering' ? <i className="fa-solid fa-circle-notch fa-spin mr-1" /> : null}
              {session.state}
            </span>
            <span className="text-muted-foreground/50">|</span>
            <span>{session.current_time} / {session.duration}</span>
          </div>
          <span>{session.progress?.toFixed(0)}%</span>
        </div>

        <div className="relative h-1 w-full bg-muted">
          <div
            className={`absolute left-0 top-0 h-full transition-all duration-500 ease-out ${stateColor.split(' ')[1]}`}
            style={{ width: `${session.progress || 0}%` }}
          />
        </div>

        {/* --- Technical Details Section --- */}
        <div className="flex flex-1 flex-col gap-2 p-4 backdrop-blur-sm">
          {/* Container Line */}
          <div className="flex items-start gap-3 text-xs sm:text-sm">
            <span className="min-w-[40px] font-medium text-muted-foreground">Container</span>
            <span className="text-foreground/90 font-medium">
              {session.container_detail || 'Unknown'}
            </span>
          </div>

          {/* Video Line */}
          <div className="flex items-start gap-3 text-xs sm:text-sm">
            <span className="min-w-[40px] font-medium text-muted-foreground">Video</span>
            <div className="flex flex-col">
              <span className="text-foreground/90 font-medium">
                {session.video_detail || 'Unknown Video'}
                {session.bitrate_calc ? ` (${Math.round(session.bitrate_calc / 1000)} Mbps)` : ''}
              </span>
              <span className="flex items-center gap-1 text-[11px] sm:text-xs text-muted-foreground">
                <i className={`fa-solid fa-arrow-turn-up text-[10px] transform rotate-90`} />
                {isTranscoding ? (
                  <span className="text-amber-400 flex items-center gap-1">
                    <span className="flex items-center gap-1">
                      Transcode {session.transcode_reason ? `(${session.transcode_reason})` : ''}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowStreamInfo(true);
                        }}
                        className="hover:text-amber-300 transition-colors focus:outline-none"
                        title="What does this mean?"
                      >
                        <i className="fa-solid fa-circle-info text-[10px]" />
                      </button>
                    </span>
                    {session.transcode_throttled !== undefined || session.transcode_speed !== undefined ? (
                      <span className="text-gray-500 flex items-center gap-1 ml-1">
                        ({session.transcode_throttled ? 'Throttled' : 'Active'}
                        {session.transcode_speed !== undefined && session.transcode_speed > 0 ? `, Speed: ${session.transcode_speed}` : ''})
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-green-400 flex items-center gap-1">
                    {directMethodLabel}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowStreamInfo(true);
                      }}
                      className="hover:text-green-300 transition-colors focus:outline-none"
                      title="What does this mean?"
                    >
                      <i className="fa-solid fa-circle-info text-[10px]" />
                    </button>
                  </span>
                )}
              </span>
            </div>
          </div>
          <StreamInfoDialog open={showStreamInfo} onOpenChange={setShowStreamInfo} />



          {/* Audio Line */}
          <div className="flex items-start gap-3 text-xs sm:text-sm">
            <span className="min-w-[40px] font-medium text-muted-foreground">Audio</span>
            <div className="flex flex-col">
              <span className="text-foreground/90 font-medium">{resolvedAudioDetail || 'Unknown Audio'}</span>
              {isTranscoding && session.stream_detail?.toLowerCase().includes('audio') && (
                <span className="flex items-center gap-1 text-[11px] sm:text-xs text-gray-400">
                  <i className={`fa-solid fa-arrow-turn-up text-[10px] transform rotate-90`} />
                  <span className="text-amber-400 flex items-center gap-1">
                    <span className="flex items-center gap-1">
                      Transcode
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowStreamInfo(true);
                        }}
                        className="hover:text-amber-300 transition-colors focus:outline-none"
                        title="What does this mean?"
                      >
                        <i className="fa-solid fa-circle-info text-[10px]" />
                      </button>
                    </span>
                    {session.transcode_throttled !== undefined || session.transcode_speed !== undefined ? (
                      <span className="text-gray-500 flex items-center gap-1 ml-1">
                        ({session.transcode_throttled ? 'Throttled' : 'Active'}
                        {session.transcode_speed !== undefined && session.transcode_speed > 0 ? `, Speed: ${session.transcode_speed}` : ''})
                      </span>
                    ) : null}
                  </span>
                </span>
              )}        </div>
          </div>

          {/* Subtitle Line */}
          {session.subtitle_detail && (
            <div className="flex items-start gap-3 text-xs sm:text-sm">
              <span className="min-w-[40px] font-medium text-muted-foreground">Sub</span>
              <span className="text-foreground/90 font-medium">{session.subtitle_detail}</span>
            </div>
          )}
        </div>

        {/* --- Footer (User & Player) --- */}
        <div className="flex items-center justify-between p-3 sm:p-4 border-t-[1.5px] border-muted">
          <div className="flex items-center gap-3 overflow-hidden">
            {/* Avatar */}
            <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full sm:h-12 sm:w-12">
              {session.user_avatar_url ? (
                <img src={session.user_avatar_url} alt={session.user} className="h-full w-full object-cover" />
              ) : (
                <div className={`flex h-full w-full items-center justify-center ${avatarBgClass} font-bold ${avatarTextClass}`}>
                  {session.user?.[0]?.toUpperCase()}
                </div>
              )}
            </div>

            <div className="flex flex-col min-w-0">
              {canNavigateToUserProfile ? (
                <a
                  href={buildUserProfilePath({
                    uuid: session.mum_user_uuid,
                    username: session.user,
                    server_nickname: session.server_name,
                  })}
                  onClick={(e) => void handleUserProfileClick(e)}
                  className="truncate text-left text-sm font-bold text-primary hover:underline sm:text-base"
                  title="Open user profile"
                >
                  {session.user}
                </a>
              ) : (
                <span className="truncate text-left text-sm font-bold text-foreground sm:text-base">
                  {session.user}
                </span>
              )}
              <div className="flex flex-col text-xs text-muted-foreground sm:text-sm">
                <div className="flex items-center gap-1 truncate">
                  <span className="text-muted-foreground/80">{session.player_title}</span>
                  <i className="fa-solid fa-arrow-right text-[10px] opacity-50" />
                  <span className="text-muted-foreground/80">{session.player_platform}</span>
                </div>
                <div className="truncate text-[11px] opacity-70">
                  {session.location_detail}
                </div>
              </div>
            </div>
          </div>

          {/* Platform Icon / Service Watermark (Right side of footer) */}
          <div className="flex flex-col items-end gap-1 opacity-50">
            <span className="text-[10px] uppercase tracking-widest">{serviceMeta.label}</span>
            {/* Could add a logo here if available */}
          </div>
        </div>
      </div>
    </div>
  );
};
