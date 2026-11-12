import { useState } from 'react';
import { syncAllUsers, userSyncNotices } from '../../lib/userSync';
import { useAlerts } from '../../contexts/AlertContext';
import { Button } from '../ui/button';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSync } from '@fortawesome/free-solid-svg-icons';
import { Spinner } from '@/components/ui/spinner'

export const SyncUsersButton = () => {
  const [syncing, setSyncing] = useState(false);
  const { success, error } = useAlerts();

  const handleSync = async () => {
    setSyncing(true);
    try {
      const { results, summary } = await syncAllUsers();
      for (const notice of userSyncNotices(results, summary)) {
        (notice.ok ? success : error)(notice.text);
      }
    } catch (err) {
      error(`Failed to sync users: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Button
      onClick={handleSync}
      disabled={syncing}
      size="sm"
      type="button"
    >
      {syncing ? (
        <>
          <Spinner className="h-3 w-3 mr-2" />
          Syncing...
        </>
      ) : (
        <>
          <FontAwesomeIcon icon={faSync} className="mr-2" />
          Sync All Users
        </>
      )}
    </Button>
  );
};
