import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Textarea } from '@/components/ui/textarea';
import type { ActiveSession } from '@/types/streaming';

type TerminateSession = Pick<
  ActiveSession,
  'session_key' | 'user' | 'media_title' | 'service_type' | 'server_name'
>;

interface TerminateSessionModalProps {
  open: boolean;
  session: TerminateSession | null;
  message: string;
  onMessageChange: (message: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

export const TerminateSessionModal = ({
  open,
  session,
  message,
  onMessageChange,
  onClose,
  onConfirm
}: TerminateSessionModalProps) => {
  const serviceType = session?.service_type?.toLowerCase();
  const supportsTerminationMessage = serviceType !== 'audiobookshelf';

  return (
    <ResponsiveDialog
      open={open && Boolean(session)}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      title="Terminate Session"
      description="End an active streaming session."
      contentClassName="max-w-lg"
      footer={[
        <Button key="cancel" variant="outline" onClick={onClose}>
          Cancel
        </Button>,
        <Button key="terminate" variant="destructive" onClick={onConfirm} className="gap-2">
          <i className="fa-solid fa-ban" />
          Terminate Session
        </Button>,
      ]}
    >
      {session ? (
        <div className="space-y-6">
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/20">
                <i className="fa-solid fa-exclamation-triangle text-destructive" />
              </div>
              <div className="space-y-1">
                <h4 className="text-base font-semibold text-foreground">Confirm Session Termination</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Are you sure you want to terminate the session for <strong>{session.user}</strong> playing{' '}
                  <strong>{session.media_title}</strong>?
                </p>
              </div>
            </div>
          </div>

          {supportsTerminationMessage ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <i className="fa-solid fa-message text-blue-600 dark:text-blue-400 text-sm" />
                <h5 className="text-base font-semibold text-foreground">Optional Message</h5>
              </div>
              <Textarea
                rows={3}
                placeholder="e.g., Server maintenance starting soon."
                value={message}
                onChange={(e) => onMessageChange(e.target.value)}
                className="resize-none"
              />
              <p className="text-sm text-muted-foreground">
                This message will be displayed to the user when their session is terminated.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Messages are not supported for AudioBookshelf session termination.
            </p>
          )}
        </div>
      ) : null}
    </ResponsiveDialog>
  );
};
