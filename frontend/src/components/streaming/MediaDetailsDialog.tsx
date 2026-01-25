import { useRef, useState } from 'react';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { ActiveSession } from '@/types/streaming';
import { Button } from '@/components/ui/button';
import { useAlerts } from '@/contexts/AlertContext';

interface MediaDetailsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    session: ActiveSession;
}

interface MediaDetailItem {
    label: string;
    value: string | number | null | undefined;
}

const DetailCard = ({ label, value }: MediaDetailItem) => (
    <div className="flex flex-col rounded-lg bg-zinc-900/50 p-3 border border-zinc-800">
        <span className="text-[10px] uppercase text-zinc-500 font-semibold tracking-wider mb-1">{label}</span>
        <span className="text-sm font-medium text-zinc-100 truncate" title={String(value)}>{value ?? 'N/A'}</span>
    </div>
);

export function MediaDetailsDialog({ open, onOpenChange, session }: MediaDetailsDialogProps) {
    const { success, error: showError } = useAlerts();

    // Parse raw data to extract detailed info
    let details: Record<string, string | number | null | undefined> = {
        path: session.media_path,
        duration: session.media_duration,
        bitrate: session.media_bitrate,
        width: session.media_width,
        height: session.media_height,
        aspectRatio: session.media_aspect_ratio,
        audioChannels: session.media_audio_channels,
        audioCodec: session.media_audio_codec,
        videoCodec: session.media_video_codec,
        videoResolution: session.media_video_resolution,
        container: session.media_container,
        videoFrameRate: session.media_video_frame_rate,
        videoProfile: session.media_video_profile,
        hasVoiceActivity: session.media_has_voice_activity,
        author: session.media_author,
        publisher: session.media_publisher,
        isbn: session.media_isbn,
        genres: session.media_genres,
        chapterTitle: session.media_chapter_title,
        chapterIndex: session.media_chapter_index,
        chapterCount: session.media_chapter_count,
        mediaPlayer: session.media_player,
        abridged: session.media_abridged,
        explicit: session.media_explicit,
        language: session.media_language,
        series: session.media_series,
    };
    try {
        const needsRawFallback = Object.values(details).some((value) => value === undefined || value === null);
        if (needsRawFallback && session.raw_data_json) {
            const raw = JSON.parse(session.raw_data_json) as Record<string, any>;

            const pickFirst = (value: any) => (Array.isArray(value) ? value[0] : value);
            const getAttr = (obj: any, key: string) => {
                if (!obj) return undefined;
                if (obj[key] !== undefined) return obj[key];
                const atKey = `@${key}`;
                if (obj[atKey] !== undefined) return obj[atKey];
                return undefined;
            };
            const toNumber = (value: any) => {
                if (value === null || value === undefined) return undefined;
                const num = Number(value);
                return Number.isFinite(num) ? num : undefined;
            };

            const root =
                raw.Video ||
                raw.Track ||
                pickFirst(raw.MediaContainer?.Video) ||
                pickFirst(raw.MediaContainer?.Track) ||
                raw;

            const media = pickFirst(root?.Media);
            const part = pickFirst(media?.Part);
            const streams = part?.Stream;

            const getStream = (type: number) => {
                if (Array.isArray(streams)) {
                    return streams.find((s) => Number(getAttr(s, 'streamType')) === type) ?? null;
                }
                if (streams && Number(getAttr(streams, 'streamType')) === type) return streams;
                return null;
            };
            const videoStream = getStream(1);
            const audioStream = getStream(2);

            const rawDetails = {
                path: getAttr(part, 'file'),
                duration: toNumber(getAttr(root, 'duration')) ?? toNumber(getAttr(media, 'duration')),
                bitrate: toNumber(getAttr(media, 'bitrate')),
                width: toNumber(getAttr(media, 'width')) ?? toNumber(getAttr(videoStream, 'width')),
                height: toNumber(getAttr(media, 'height')) ?? toNumber(getAttr(videoStream, 'height')),
                aspectRatio: getAttr(media, 'aspectRatio') ?? getAttr(videoStream, 'aspectRatio'),
                audioChannels: toNumber(getAttr(media, 'audioChannels')) ?? toNumber(getAttr(audioStream, 'channels')),
                audioCodec: getAttr(media, 'audioCodec') ?? getAttr(audioStream, 'codec'),
                videoCodec: getAttr(media, 'videoCodec') ?? getAttr(videoStream, 'codec'),
                videoResolution: getAttr(media, 'videoResolution') ?? getAttr(root, 'videoResolution'),
                container: getAttr(media, 'container'),
                videoFrameRate: getAttr(media, 'videoFrameRate') ?? getAttr(videoStream, 'frameRate'),
                videoProfile: getAttr(videoStream, 'profile'),
                hasVoiceActivity: getAttr(media, 'hasVoiceActivity'),
            };
            details = {
                path: details.path ?? rawDetails.path,
                duration: details.duration ?? rawDetails.duration,
                bitrate: details.bitrate ?? rawDetails.bitrate,
                width: details.width ?? rawDetails.width,
                height: details.height ?? rawDetails.height,
                aspectRatio: details.aspectRatio ?? rawDetails.aspectRatio,
                audioChannels: details.audioChannels ?? rawDetails.audioChannels,
                audioCodec: details.audioCodec ?? rawDetails.audioCodec,
                videoCodec: details.videoCodec ?? rawDetails.videoCodec,
                videoResolution: details.videoResolution ?? rawDetails.videoResolution,
                container: details.container ?? rawDetails.container,
                videoFrameRate: details.videoFrameRate ?? rawDetails.videoFrameRate,
                videoProfile: details.videoProfile ?? rawDetails.videoProfile,
                hasVoiceActivity: details.hasVoiceActivity ?? rawDetails.hasVoiceActivity,
            };

            // Handle Tautulli/other variations if needed, but start with standard Plex key names
            // If direct properies exist on raw root (sometimes flattened)
            if (!details.path && raw.File) details.path = raw.File;
        }
    } catch (e) {
        console.error("Failed to parse session raw data", e);
    }

    // Formatting helpers
    const formatDuration = (ms?: number) => {
        if (!ms) return 'N/A';
        const totalSeconds = Math.floor(ms / 1000);
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    const formatBitrate = (kbps?: number) => {
        if (!kbps) return 'N/A';
        if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
        return `${kbps.toFixed(0)} kbps`;
    };

    const handleCopyPath = async () => {
        if (details.path) {
            try {
                await navigator.clipboard.writeText(details.path);
                success('Path copied to clipboard');
            } catch (err) {
                showError('Failed to copy path');
            }
        }
    };

    const hasVoiceActivity =
        details.hasVoiceActivity === 1 ||
        details.hasVoiceActivity === '1' ||
        details.hasVoiceActivity === true;
    const hasVideo =
        Boolean(details.videoCodec) ||
        Boolean(details.videoProfile) ||
        Boolean(details.videoResolution) ||
        Boolean(details.width) ||
        Boolean(details.height);

    const chapterIndex = typeof details.chapterIndex === 'number' ? details.chapterIndex : undefined;
    const chapterCount = typeof details.chapterCount === 'number' ? details.chapterCount : undefined;
    const chapterTitle = details.chapterTitle ? String(details.chapterTitle) : '';
    let chapterValue: string | undefined;
    if (chapterIndex && chapterCount) {
        chapterValue = `Chapter ${chapterIndex} / ${chapterCount}${chapterTitle ? `: ${chapterTitle}` : ''}`;
    } else if (chapterTitle) {
        chapterValue = chapterTitle;
    }

    const detailItems: MediaDetailItem[] = [
        { label: 'DURATION', value: formatDuration(details.duration as number | undefined) },
        { label: 'BITRATE', value: formatBitrate(details.bitrate as number | undefined) },
        { label: 'WIDTH', value: details.width, },
        { label: 'HEIGHT', value: details.height, },
        { label: 'ASPECT RATIO', value: details.aspectRatio, },
        { label: 'AUDIO CHANNELS', value: details.audioChannels, },
        { label: 'AUDIO CODEC', value: details.audioCodec ? String(details.audioCodec).toUpperCase() : 'N/A' },
        { label: 'VIDEO CODEC', value: details.videoCodec ? String(details.videoCodec).toUpperCase() : 'N/A' },
        { label: 'VIDEO RESOLUTION', value: details.videoResolution, },
        { label: 'CONTAINER', value: details.container ? String(details.container).toUpperCase() : 'N/A' },
        { label: 'VIDEO FRAME RATE', value: details.videoFrameRate, },
        { label: 'VIDEO PROFILE', value: details.videoProfile ? String(details.videoProfile).toUpperCase() : 'N/A' },
        { label: 'HAS VOICE ACTIVITY', value: hasVoiceActivity ? 'Yes' : hasVoiceActivity === false ? 'No' : 'N/A' },
        { label: 'AUTHOR', value: details.author },
        { label: 'SERIES', value: details.series },
        { label: 'PUBLISHER', value: details.publisher },
        { label: 'ISBN', value: details.isbn },
        { label: 'LANGUAGE', value: details.language },
        { label: 'GENRES', value: details.genres },
        { label: 'MEDIA PLAYER', value: details.mediaPlayer },
        { label: 'CHAPTER', value: chapterValue },
        { label: 'ABRIDGED', value: details.abridged === true ? 'Yes' : details.abridged === false ? 'No' : undefined },
        { label: 'EXPLICIT', value: details.explicit === true ? 'Yes' : details.explicit === false ? 'No' : undefined },
    ];

    return (
        <ResponsiveDialog
            open={open}
            onOpenChange={onOpenChange}
            title={<span className="text-base font-bold tracking-wide uppercase text-zinc-100">MEDIA DETAILS</span>}
            contentClassName="bg-black border-zinc-800 text-zinc-100 max-w-xl p-0 gap-0 overflow-hidden"
            headerClassName="px-6 py-4 border-b border-zinc-800 bg-black"
            bodyClassName="p-0 bg-black"
        >
            <div className="max-h-[80vh] overflow-y-auto">
                <div className="p-6 space-y-6">

                    {/* Path Section */}
                    <div className="rounded-lg bg-zinc-900/50 p-4 border border-zinc-800 flex items-center justify-between group">
                        <div className="flex flex-col min-w-0 pr-4">
                            <span className="text-[10px] uppercase text-zinc-500 font-semibold tracking-wider mb-1">PATH</span>
                            <span className="text-sm font-medium text-zinc-100 break-all leading-relaxed font-mono">
                                {details.path || 'Path unavailable'}
                            </span>
                        </div>
                        {details.path && (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={handleCopyPath}
                                className="text-zinc-400 hover:text-white hover:bg-zinc-800 shrink-0"
                            >
                                <i className="fa-solid fa-copy" />
                            </Button>
                        )}
                    </div>

                    {/* Grid Details */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {detailItems
                            .filter((item) => {
                                const hiddenWhenNoVideo = new Set([
                                    'WIDTH',
                                    'HEIGHT',
                                    'ASPECT RATIO',
                                    'VIDEO RESOLUTION',
                                    'VIDEO FRAME RATE',
                                ]);
                                if (!hasVideo && hiddenWhenNoVideo.has(item.label)) return false;
                                const value = item.value;
                                if (value === null || value === undefined || value === '') return false;
                                if (value === 'N/A' && !['VIDEO CODEC', 'VIDEO PROFILE'].includes(item.label)) return false;
                                return true;
                            })
                            .map((item) => (
                                <DetailCard key={item.label} label={item.label} value={item.value} />
                            ))}
                    </div>

                </div>
            </div>
        </ResponsiveDialog>
    );
}
