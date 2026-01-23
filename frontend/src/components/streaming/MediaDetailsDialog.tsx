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
    let details: Record<string, string | number | null | undefined> = {};
    try {
        if (session.raw_data_json) {
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

            details = {
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
                        <DetailCard label="DURATION" value={formatDuration(details.duration)} />
                        <DetailCard label="BITRATE" value={formatBitrate(details.bitrate)} />
                        <DetailCard label="WIDTH" value={details.width} />

                        <DetailCard label="HEIGHT" value={details.height} />
                        <DetailCard label="ASPECT RATIO" value={details.aspectRatio} />
                        <DetailCard label="AUDIO CHANNELS" value={details.audioChannels} />

                        <DetailCard label="AUDIO CODEC" value={String(details.audioCodec || '').toUpperCase()} />
                        <DetailCard label="VIDEO CODEC" value={String(details.videoCodec || '').toUpperCase()} />
                        <DetailCard label="VIDEO RESOLUTION" value={details.videoResolution} />

                        <DetailCard label="CONTAINER" value={String(details.container || '').toUpperCase()} />
                        <DetailCard label="VIDEO FRAME RATE" value={details.videoFrameRate} />
                        <DetailCard label="VIDEO PROFILE" value={String(details.videoProfile || '').toUpperCase()} />

                        <DetailCard label="HAS VOICE ACTIVITY" value={hasVoiceActivity ? "Yes" : "No"} />
                    </div>

                </div>
            </div>
        </ResponsiveDialog>
    );
}
