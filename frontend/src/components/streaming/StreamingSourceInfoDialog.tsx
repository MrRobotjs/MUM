import { ResponsiveDialog } from '@/components/ui/responsive-dialog';

type StreamingSourceInfoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const StreamingSourceInfoDialog = ({
  open,
  onOpenChange,
}: StreamingSourceInfoDialogProps) => (
  <ResponsiveDialog
    open={open}
    onOpenChange={onOpenChange}
    title="Streaming Source Badges"
    description="How WS and HTTP updates are sourced"
  >
    <div className="space-y-4 text-sm text-muted-foreground">
      <div className="space-y-1">
        <p className="font-semibold text-foreground">WS badge</p>
        <p>Updates triggered by a live WebSocket connection from a media service (Plex, Jellyfin, Emby).</p>
      </div>
      <div className="space-y-1">
        <p className="font-semibold text-foreground">HTTP badge</p>
        <p>Complete snapshots triggered by bootstrap or periodic polling, including recovery when a provider socket is unavailable.</p>
        <p>
          The "HTTP next" badge counts down to the next dashboard refresh. Provider polling follows its saved monitoring interval.
        </p>
        <p>
          These come from <code className="font-mono text-xs">/api/activity/current</code>.
        </p>
      </div>
      <div className="rounded-lg border border-border/60 bg-muted/40 p-3 text-foreground/80">
        <p className="font-semibold text-foreground">Plex note</p>
        <p>
          Plex sessions are retrieved over HTTP, but the fetch is triggered by Plex WebSocket events.
          Those updates are labeled as WS because the trigger is realtime, even though the payload is HTTP.
        </p>
      </div>
    </div>
  </ResponsiveDialog>
);
