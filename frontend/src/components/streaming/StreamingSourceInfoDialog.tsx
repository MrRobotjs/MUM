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
        <p>Updates fetched via HTTP (bootstrap or polling) for services without realtime sockets.</p>
        <p>
          These come from <code className="font-mono text-xs">/admin/api/v2/streaming/active</code>.
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
