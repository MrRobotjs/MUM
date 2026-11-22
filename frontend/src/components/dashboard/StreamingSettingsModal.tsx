import { useSyncExternalStore } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { getAuthSnapshot, subscribeToAuthStore } from '../../store/authStore';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { Button } from '../ui/button';
import { StreamingMapSettings } from '../settings/StreamingMapSettings';

type StreamingSettingsModalProps = { open: boolean; onClose: () => void };

export const StreamingSettingsModal = ({ open, onClose }: StreamingSettingsModalProps) => {
  const { user, isAdministrator } = useAuth();
  const session = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot);
  if (!open || !user || !session.accessToken) return null;
  // A fresh session/open mounts fresh drafts. The established cards own their
  // independent save guards, uncertainty handling and shared read caches.
  return <ResponsiveDialog
    key={`${user.uuid}:${session.accessToken}:${isAdministrator}`}
    open={open} onOpenChange={value => { if (!value) onClose(); }}
    title="Streaming Settings"
    description="Manage the Live User Map."
    footer={<Button variant="outline" onClick={onClose}>Close</Button>}
    contentClassName="max-w-lg" bodyClassName="space-y-4"
  >
    {isAdministrator && <StreamingMapSettings />}
    {!isAdministrator && <p className="text-sm text-muted-foreground">No streaming settings are available for this account.</p>}
  </ResponsiveDialog>;
};

export default StreamingSettingsModal;
