import { Button } from '@/components/ui/button';

type ActiveSession = {
  session_key: string;
  user: string;
  user_avatar_url?: string;
  mum_user_id?: number;
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
};

interface StreamingSessionCardProps {
  session: ActiveSession;
  onTerminate: (session: ActiveSession) => void;
}

const getCardBgClass = (serviceType: string) => {
  switch (serviceType) {
    case 'plex': return 'bg-gradient-to-br from-base-200 to-plex/10';
    case 'jellyfin': return 'bg-gradient-to-br from-base-200 to-jellyfin/10';
    case 'emby': return 'bg-gradient-to-br from-base-200 to-emby/10';
    case 'kavita': return 'bg-gradient-to-br from-base-200 to-kavita/10';
    case 'audiobookshelf': return 'bg-gradient-to-br from-base-200 to-audiobookshelf/10';
    case 'komga': return 'bg-gradient-to-br from-base-200 to-komga/10';
    case 'romm': return 'bg-gradient-to-br from-base-200 to-romm/10';
    default: return 'bg-muted';
  }
};

const getServiceBgClass = (serviceType: string) => {
  switch (serviceType) {
    case 'plex': return 'bg-plex';
    case 'jellyfin': return 'bg-jellyfin';
    case 'emby': return 'bg-emby';
    case 'kavita': return 'bg-kavita';
    case 'audiobookshelf': return 'bg-audiobookshelf';
    case 'komga': return 'bg-komga';
    case 'romm': return 'bg-romm';
    default: return 'bg-primary';
  }
};

export const StreamingSessionCard = ({ session, onTerminate }: StreamingSessionCardProps) => {
  return (
    <div
      key={session.session_key}
      className={`card ${getCardBgClass(session.service_type)} shadow-lg w-full max-w-md relative group`}
      tabIndex={0}
    >
      {/* Action buttons (top right) */}
      <div className="absolute top-2 right-2 z-10 flex space-x-1 opacity-0 pointer-events-none transition-opacity duration-200 group-hover:opacity-100 group-hover:pointer-events-auto group-focus:opacity-100 group-focus:pointer-events-auto">
        <Button
          variant="destructive"
          size="icon"
          className="h-7 w-7 rounded-full"
          onClick={() => onTerminate(session)}
          title="Terminate Session"
        >
          <i className="fa-solid fa-times text-sm" />
        </Button>
      </div>

      <div className="card-body p-3">
        {/* Main Flex Container: Poster | Details */}
        <div className="flex items-start space-x-3">
          {/* Poster Column */}
          <div className="avatar flex-shrink-0">
            <div className="w-30 h-45 rounded">
              {session.thumb_url ? (
                <img
                  src={session.thumb_url || ''}
                  alt={`${session.media_title} Poster`}
                  className="w-full h-full object-cover"
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                    if (e.currentTarget.nextElementSibling) {
                      (e.currentTarget.nextElementSibling as HTMLElement).style.display = 'flex';
                    }
                  }}
                />
              ) : null}
              {/* Fallback when image fails to load or no image */}
              <div
                className="w-full h-full bg-muted flex flex-col items-center justify-center text-xs text-muted-foreground"
                style={{ display: session.thumb_url ? 'none' : 'flex' }}
              >
                <i className="fa-solid fa-image fa-2x mb-1" />
                <div>No Poster</div>
              </div>
            </div>
          </div>

          {/* Details Column */}
          <div className="flex-grow min-w-0">
            <div className="text-xs space-y-0.5 mt-1">
              {/* User */}
              <p className="text-foreground/80 flex items-center" title={session.user}>
                {session.user_avatar_url ? (
                  <div className="avatar avatar-xs mr-1.5">
                    <div className="w-4 h-4 rounded-full">
                      <img
                        src={session.user_avatar_url || ''}
                        alt={`${session.user} avatar`}
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                          if (e.currentTarget.nextElementSibling) {
                            (e.currentTarget.nextElementSibling as HTMLElement).style.display = 'flex';
                          }
                        }}
                      />
                      {/* Fallback avatar */}
                      <div
                        className={`${getServiceBgClass(session.service_type)} text-white w-4 h-4 rounded-full flex items-center justify-center text-[0.5rem] font-bold`}
                        style={{ display: 'none' }}
                      >
                        {session.user?.[0]?.toUpperCase() || 'U'}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="avatar avatar-xs mr-1.5">
                    <div className={`${getServiceBgClass(session.service_type)} text-white w-4 h-4 rounded-full flex items-center justify-center text-[0.5rem] font-bold`}>
                      {session.user?.[0]?.toUpperCase() || 'U'}
                    </div>
                  </div>
                )}
                <span className="link link-hover text-blue-600 dark:text-blue-400" title="User">
                  {session.user}
                </span>
              </p>

              {/* Player */}
              <p className="text-muted-foreground flex items-center" title={`${session.player_title} (${session.player_platform} via ${session.product})`}>
                <i className="fa-solid fa-play fa-fw mr-1.5 text-blue-600 dark:text-blue-400 w-4 text-center" />
                <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Player:</span>
                {session.player_title}{' '}
                <span className="text-muted-foreground ml-1">
                  ({session.product !== session.player_title ? session.product : session.player_platform})
                </span>
              </p>

              {/* Media/Library */}
              <p className="text-muted-foreground flex items-center">
                <i className="fa-solid fa-tv fa-fw mr-1.5 text-blue-600 dark:text-blue-400 w-4 text-center" />
                <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Media/Library:</span>
                {session.media_type} on {session.library_name}
              </p>

              {/* Quality */}
              <p className="text-muted-foreground flex items-center" title={`Quality: ${session.quality_detail}`}>
                <i className="fa-solid fa-sliders fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Quality:</span>
                <span>{session.quality_detail}</span>
              </p>

              {/* Stream */}
              <p className="text-muted-foreground flex items-center" title={`Stream: ${session.stream_detail}`}>
                <i className="fa-solid fa-wifi fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Stream:</span>
                <span className={`font-medium ${session.stream_detail?.includes('Transcode') ? 'text-orange-400' : 'text-green-400'}`}>
                  {session.stream_detail}
                </span>
                {session.stream_detail?.includes('Transcode') && session.transcode_reason && (
                  <i className="fa-solid fa-info-circle ml-1 text-orange-400/80" title={`Reason: ${session.transcode_reason}`} />
                )}
              </p>

              {/* Container */}
              {session.container_detail && (
                <p className="text-muted-foreground flex items-center" title={`Container: ${session.container_detail}`}>
                  <i className="fa-solid fa-box-archive fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                  <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Container:</span>
                  <span>{session.container_detail}</span>
                </p>
              )}

              {/* Video */}
              {session.video_detail && (
                <p className="text-muted-foreground flex items-center" title={`Video: ${session.video_detail}`}>
                  <i className="fa-solid fa-film fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                  <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Video:</span>
                  <span>{session.video_detail}</span>
                </p>
              )}

              {/* Audio */}
              {session.audio_detail && (
                <p className="text-muted-foreground flex items-center" title={`Audio: ${session.audio_detail}`}>
                  <i className="fa-solid fa-volume-high fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                  <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Audio:</span>
                  <span>{session.audio_detail}</span>
                </p>
              )}

              {/* Subtitle */}
              {session.subtitle_detail && (
                <p className="text-muted-foreground flex items-center" title={`Subtitle: ${session.subtitle_detail}`}>
                  <i className="fa-solid fa-closed-captioning fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                  <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Subtitle:</span>
                  <span>{session.subtitle_detail}</span>
                </p>
              )}

              {/* Location */}
              <p className="text-muted-foreground flex items-center" title={`Location: ${session.location_detail}`}>
                <i className="fa-solid fa-location-dot fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Location:</span>
                <span>{session.location_detail}</span>
              </p>
            </div>
          </div>
        </div>

        {/* Progress Bar and State */}
        <div className="mt-2">
          <div className="flex justify-between items-center mb-1.5">
            <div className="flex items-center gap-2">
              <span
                className={`text-xs font-semibold uppercase tracking-wide flex items-center gap-1.5 ${
                  session.state?.toLowerCase() === 'playing' || session.state?.toLowerCase() === 'listening'
                    ? 'text-green-600 dark:text-green-400'
                    : session.state?.toLowerCase() === 'paused'
                    ? 'text-amber-600 dark:text-amber-400'
                    : session.state?.toLowerCase() === 'buffering'
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-muted-foreground'
                }`}
              >
                {(session.state?.toLowerCase() === 'playing' || session.state?.toLowerCase() === 'listening') && (
                  <i className="fa-solid fa-circle-play" />
                )}
                {session.state?.toLowerCase() === 'paused' && (
                  <i className="fa-solid fa-circle-pause" />
                )}
                {session.state?.toLowerCase() === 'buffering' && (
                  <i className="fa-solid fa-circle-notch fa-spin" />
                )}
                {session.state || 'Unknown'}
              </span>

              {/* Server Badge */}
              <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset gap-1 ${
                session.service_type === 'plex' ? 'bg-plex-50 dark:bg-plex-400/10 text-plex-700 dark:text-plex-400 ring-plex-600/20 dark:ring-plex-500/20' :
                session.service_type === 'jellyfin' ? 'bg-jellyfin-50 dark:bg-jellyfin-400/10 text-jellyfin-700 dark:text-jellyfin-400 ring-jellyfin-600/20 dark:ring-jellyfin-500/20' :
                session.service_type === 'emby' ? 'bg-emby-50 dark:bg-emby-400/10 text-emby-700 dark:text-emby-400 ring-emby-600/20 dark:ring-emby-500/20' :
                session.service_type === 'kavita' ? 'bg-kavita-50 dark:bg-kavita-400/10 text-kavita-700 dark:text-kavita-400 ring-kavita-600/20 dark:ring-kavita-500/20' :
                session.service_type === 'audiobookshelf' ? 'bg-audiobookshelf-50 dark:bg-audiobookshelf-400/10 text-audiobookshelf-700 dark:text-audiobookshelf-400 ring-audiobookshelf-600/20 dark:ring-audiobookshelf-500/20' :
                session.service_type === 'komga' ? 'bg-komga-50 dark:bg-komga-400/10 text-komga-700 dark:text-komga-400 ring-komga-600/20 dark:ring-komga-500/20' :
                session.service_type === 'romm' ? 'bg-romm-50 dark:bg-romm-400/10 text-romm-700 dark:text-romm-400 ring-romm-600/20 dark:ring-romm-500/20' :
                'bg-gray-50 dark:bg-gray-400/10 text-gray-700 dark:text-gray-400 ring-gray-600/20 dark:ring-gray-500/20'
              }`}>
                {session.service_type === 'plex' && (
                  <svg className="w-3 h-3" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="transparent" strokeLinejoin="round" strokeWidth="12">
                    <path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z"/>
                  </svg>
                )}
                {session.service_type !== 'plex' && <i className="fa-solid fa-server w-3 h-3" />}
                {session.server_name}
              </span>
            </div>
            <span className="text-xs font-medium text-foreground/90 tabular-nums">
              {session.current_time} / {session.duration}
            </span>
          </div>

          {/* Custom Progress Bar */}
          <div className="relative w-full h-2 bg-muted/40 rounded-full overflow-hidden shadow-inner">
            <div
              className={`absolute top-0 left-0 h-full rounded-full transition-all duration-300 ease-out shadow-sm ${
                session.state?.toLowerCase() === 'playing' || session.state?.toLowerCase() === 'listening'
                  ? 'bg-gradient-to-r from-green-500 to-green-600 dark:from-green-400 dark:to-green-500'
                  : session.state?.toLowerCase() === 'paused'
                  ? 'bg-gradient-to-r from-amber-500 to-amber-600 dark:from-amber-400 dark:to-amber-500'
                  : session.state?.toLowerCase() === 'buffering'
                  ? 'bg-gradient-to-r from-blue-500 to-blue-600 dark:from-blue-400 dark:to-blue-500 animate-pulse'
                  : 'bg-gradient-to-r from-primary to-primary/80'
              }`}
              style={{ width: `${session.progress || 0}%` }}
            >
              {/* Shine effect */}
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            </div>
          </div>

          {/* Progress percentage */}
          <div className="flex justify-end mt-0.5">
            <span className={`text-xs font-semibold tabular-nums ${
              session.state?.toLowerCase() === 'playing' || session.state?.toLowerCase() === 'listening'
                ? 'text-green-600 dark:text-green-400'
                : session.state?.toLowerCase() === 'paused'
                ? 'text-amber-600 dark:text-amber-400'
                : session.state?.toLowerCase() === 'buffering'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-primary'
            }`}>
              {session.progress?.toFixed(1) || 0}%
            </span>
          </div>
          <h2 className="card-title text-sm font-semibold" title={session.media_title}>
            {session.media_title || 'Unknown Title'}
            {session.year && <span className="text-xs font-normal text-muted-foreground">({session.year})</span>}
          </h2>
          {session.media_type === 'Episode' && session.grandparent_title && (
            <p className="text-xs text-primary" title={`${session.grandparent_title}${session.parent_title ? ` - ${session.parent_title}` : ''}`}>
              {session.grandparent_title}{session.parent_title ? ` - ${session.parent_title}` : ''}
            </p>
          )}
          {session.media_type === 'Track' && (session.parent_title || session.grandparent_title) && (
            <p className="text-xs text-primary" title={`${session.grandparent_title || ''}${session.grandparent_title && session.parent_title ? ' - ' : ''}${session.parent_title || ''}`}>
              {session.grandparent_title || ''}{session.grandparent_title && session.parent_title ? ' - ' : ''}{session.parent_title || ''}
            </p>
          )}
          {session.service_type === 'audiobookshelf' && session.parent_title && (
            <p className="text-xs text-primary" title={session.parent_title}>
              <i className="fa-solid fa-user-pen mr-1" />
              {session.parent_title}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
