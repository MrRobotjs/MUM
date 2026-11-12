import { useSyncExternalStore } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { getAuthSnapshot, subscribeToAuthStore } from '../../store/authStore';
import { UserPreferencesCard } from '../users/UserPreferencesCard';
import { ActivityMonitoringSettings } from '../settings/ActivityMonitoringSettings';
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
    description="Save display preferences and per-server monitoring separately. Closing does not undo saved changes."
    footer={<Button variant="outline" onClick={onClose}>Close</Button>}
    contentClassName="max-w-lg" bodyClassName="space-y-4"
  >
    <UserPreferencesCard />
    {isAdministrator && <ActivityMonitoringSettings />}
    {isAdministrator && <StreamingMapSettings />}
  </ResponsiveDialog>;
};

export default StreamingSettingsModal;
