import { useEffect, useState, type ReactNode } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTrash, faTriangleExclamation, faCircleInfo, faClockRotateLeft } from '@fortawesome/free-solid-svg-icons';
import { readPurgeCandidates, purgeUsers, lastPlayLabel, type PurgeCandidate } from '../../lib/purge';
import { EditOperationsClient, editOutcomeMessage } from '../../lib/editOperations';
import { readPlayHistory, startPlayHistoryImport, playHistoryNotice, type PlayHistoryStatus } from '../../lib/playHistory';
import { useServers } from '../../hooks/useServers';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useAlerts } from '../../contexts/AlertContext';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { Spinner } from '@/components/ui/spinner'

// For each active Plex server whose play history has not been imported, a
// notice explaining why it matters, with its own import button. Preview is
// never blocked: someone who has run MUM for a long time may not need it.
const PlexHistoryNotices = () => {
  const { servers } = useServers({ serviceType: 'plex' });
  const { current: display } = useAccountDisplay();
  const { success, error } = useAlerts();
  const [statuses, setStatuses] = useState<Record<number, PlayHistoryStatus>>({});
  const [starting, setStarting] = useState<number | null>(null);
  const [run, setRun] = useState(0);
  const active = servers.filter(server => server.service_type.toLowerCase() === 'plex' && server.effective_active !== false && server.is_active);
  const ids = active.map(server => server.id).join(',');

  useEffect(() => {
    if (!ids) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const results = await Promise.allSettled(ids.split(',').map(id => readPlayHistory(Number(id))));
      if (!live) return;
      const next: Record<number, PlayHistoryStatus> = {};
      for (const result of results) if (result.status === 'fulfilled') next[result.value.server_id] = result.value;
      setStatuses(next);
      if (Object.values(next).some(status => status.state === 'running')) timer = setTimeout(() => void load(), 2000);
    };
    void load();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [ids, run]);

  const handleImport = async (serverId: number) => {
    if (starting !== null) return;
    setStarting(serverId);
    try {
      await startPlayHistoryImport(serverId);
      success('Play history import started.');
      setRun(n => n + 1);
    } catch (err) {
      error(err instanceof Error && err.message ? err.message : 'The import could not be started.');
    } finally {
      setStarting(null);
    }
  };

  const notices = active.flatMap(server => {
    const status = statuses[server.id];
    const notice = status ? playHistoryNotice(status, server.server_nickname, display?.display) : null;
    return notice && status ? [{ server, status, notice }] : [];
  });
  if (!notices.length) return null;
  return (
    <div className="space-y-2">
      {notices.map(({ server, status, notice }) => (
        <Alert key={server.id} variant="info">
          <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>
            <p className="text-sm">{notice.body}</p>
            {status.state !== 'running' && (
              <Button type="button" variant="outline" className="mt-2" disabled={starting !== null} onClick={() => void handleImport(server.id)}>
                {starting === server.id ? <Spinner className="mr-2 size-3" /> : <FontAwesomeIcon icon={faClockRotateLeft} className="mr-2" />}
                Import play history
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
};

interface PurgeUsersModalProps {
  onClose: () => void;
  onPurgeComplete?: () => void;
}

export const PurgeUsersModal = ({ onClose, onPurgeComplete }: PurgeUsersModalProps) => {
  const [step, setStep] = useState<'criteria' | 'preview' | 'confirm'>('criteria');
  const [loading, setLoading] = useState(false);
  const [purging, setPurging] = useState(false);
  const { current: display } = useAccountDisplay();
  const { success, error } = useAlerts();

  // Criteria state
  const [inactiveDays, setInactiveDays] = useState(180);
  const [excludeSharers, setExcludeSharers] = useState(true);
  const [excludeWhitelisted, setExcludeWhitelisted] = useState(true);
  const [ignoreCreationDate, setIgnoreCreationDate] = useState(false);

  // Preview state
  const [eligibleUsers, setEligibleUsers] = useState<PurgeCandidate[]>([]);
  const [selectedUserUuids, setSelectedUserUuids] = useState<Set<string>>(new Set());

  const rule = () => ({
    inactive_days: inactiveDays,
    exclude_sharers: excludeSharers,
    exclude_whitelisted: excludeWhitelisted,
    ignore_creation_date: ignoreCreationDate
  });

  const handlePreview = async () => {
    setLoading(true);
    try {
      const users = await readPurgeCandidates(rule());
      setEligibleUsers(users);

      // Select all users by default
      setSelectedUserUuids(new Set(users.map(u => u.uuid)));

      if (users.length === 0) {
        error('No users match the purge criteria.');
      } else {
        setStep('preview');
      }
    } catch (err) {
      error(`Failed to load eligible users: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleUser = (uuid: string) => {
    setSelectedUserUuids(prev => {
      const newSet = new Set(prev);
      if (newSet.has(uuid)) {
        newSet.delete(uuid);
      } else {
        newSet.add(uuid);
      }
      return newSet;
    });
  };

  const handleToggleAll = () => {
    if (selectedUserUuids.size === eligibleUsers.length) {
      setSelectedUserUuids(new Set());
    } else {
      setSelectedUserUuids(new Set(eligibleUsers.map(u => u.uuid)));
    }
  };

  const handlePurge = async () => {
    if (selectedUserUuids.size === 0) {
      error('Please select at least one user to purge.');
      return;
    }

    setPurging(true);
    try {
      // One prepared removal; Plex confirms each before MUM removes its record.
      const receipt = await purgeUsers(new EditOperationsClient(), Array.from(selectedUserUuids), rule());
      const deleted = receipt.summary.deleted;
      const problems = editOutcomeMessage([receipt]);

      if (problems === null) {
        success(`Successfully purged ${deleted} user${deleted !== 1 ? 's' : ''}.`);
      } else {
        error(`Purged ${deleted} user${deleted !== 1 ? 's' : ''}: ${problems}`);
      }

      onPurgeComplete?.();
      onClose();
    } catch (err) {
      error(`Failed to purge users: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setPurging(false);
    }
  };

  const renderCriteriaStep = (): { body: ReactNode; footer: ReactNode[] } => ({
    body: (
      <div className="space-y-4">
        <Alert variant="warning">
          <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
          <AlertDescription>
            This removes the selected users from your Plex server and deletes their server accounts and play history from MUM. This action cannot be undone.
          </AlertDescription>
        </Alert>

        <PlexHistoryNotices />

        <div className="space-y-2">
          <Label htmlFor="inactive-days" className="font-semibold">Inactive for (days)</Label>
          <Input
            id="inactive-days"
            type="number"
            value={inactiveDays}
            onChange={(e) => setInactiveDays(Math.max(1, parseInt(e.target.value) || 0))}
            min="1"
          />
          <p className="text-sm text-muted-foreground">
            Users who haven't played anything in this many days
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="exclude-sharers"
            checked={excludeSharers}
            onCheckedChange={(checked) => setExcludeSharers(checked === true)}
          />
          <Label htmlFor="exclude-sharers" className="cursor-pointer">
            Exclude users who share back
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="exclude-whitelisted"
            checked={excludeWhitelisted}
            onCheckedChange={(checked) => setExcludeWhitelisted(checked === true)}
          />
          <Label htmlFor="exclude-whitelisted" className="cursor-pointer">
            Exclude whitelisted users
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="ignore-creation-date"
            checked={ignoreCreationDate}
            onCheckedChange={(checked) => setIgnoreCreationDate(checked === true)}
          />
          <Label htmlFor="ignore-creation-date" className="cursor-pointer">
            Ignore creation date for users who never streamed
          </Label>
        </div>
      </div>
    ),
    footer: [
      <Button key="cancel" onClick={onClose} variant="outline" type="button">
        Cancel
      </Button>,
      <Button
        key="preview"
        onClick={handlePreview}
        disabled={loading}
        type="button"
      >
        {loading ? (
          <>
            <Spinner className="mr-2 size-3" />
            Loading...
          </>
        ) : (
          'Preview Eligible Users'
        )}
      </Button>,
    ],
  });

  const renderPreviewStep = (): { body: ReactNode; footer: ReactNode[] } => ({
    body: (
      <div className="space-y-4">
        <Alert variant="info">
          <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
          <AlertDescription>
            Found {eligibleUsers.length} user{eligibleUsers.length !== 1 ? 's' : ''} matching your criteria.
            Review and select which users to purge.
          </AlertDescription>
        </Alert>

        <div className="flex items-center gap-2 border-b pb-3">
          <Checkbox
            checked={selectedUserUuids.size === eligibleUsers.length && eligibleUsers.length > 0}
            onCheckedChange={handleToggleAll}
            id="select-all"
          />
          <Label htmlFor="select-all" className="font-semibold cursor-pointer">
            Select All ({selectedUserUuids.size}/{eligibleUsers.length})
          </Label>
        </div>

        <div className="max-h-96 overflow-y-auto space-y-2">
          {eligibleUsers.map((user) => (
            <Label
              key={user.uuid}
              htmlFor={`user-${user.uuid}`}
              className="flex items-start gap-3 p-3 rounded-lg border border hover:bg-muted/50 cursor-pointer"
            >
              <Checkbox
                id={`user-${user.uuid}`}
                checked={selectedUserUuids.has(user.uuid)}
                onCheckedChange={() => handleToggleUser(user.uuid)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{user.username || 'Unknown'}</p>
                {user.email && <p className="text-sm text-muted-foreground truncate">{user.email}</p>}
                <div className="flex gap-2 mt-1 text-xs text-muted-foreground">
                  {user.server_name && (
                    <span className="badge badge-ghost badge-xs">{user.server_name}</span>
                  )}
                  <span>{user.days_since_activity} days inactive</span>
                  <span>{lastPlayLabel(user, display?.display)}</span>
                </div>
              </div>
            </Label>
          ))}
        </div>
      </div>
    ),
    footer: [
      <Button key="back" onClick={() => setStep('criteria')} variant="outline" type="button">
        Back
      </Button>,
      <Button
        key="continue"
        onClick={() => setStep('confirm')}
        disabled={selectedUserUuids.size === 0}
        type="button"
        className="bg-amber-100 hover:bg-amber-100/90 text-amber-600 dark:text-amber-400-foreground"
      >
        Continue to Confirmation
      </Button>,
    ],
  });

  const renderConfirmStep = (): { body: ReactNode; footer: ReactNode[] } => ({
    body: (
      <div className="space-y-4">
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
          <AlertDescription>
            <p className="font-semibold">Final Confirmation</p>
            <p className="text-sm">
              You are about to remove {selectedUserUuids.size} user{selectedUserUuids.size !== 1 ? 's' : ''} from your Plex server.
              This action cannot be undone.
            </p>
          </AlertDescription>
        </Alert>

        <div className="bg-muted rounded-lg p-4">
          <h3 className="font-semibold mb-2">Purge Criteria:</h3>
          <ul className="text-sm space-y-1">
            <li>• Inactive for: {inactiveDays} days</li>
            <li>• Exclude sharers: {excludeSharers ? 'Yes' : 'No'}</li>
            <li>• Exclude whitelisted: {excludeWhitelisted ? 'Yes' : 'No'}</li>
            <li>• Selected users: {selectedUserUuids.size}</li>
          </ul>
        </div>
      </div>
    ),
    footer: [
      <Button key="back" onClick={() => setStep('preview')} variant="outline" type="button">
        Back
      </Button>,
      <Button
        key="purge"
        onClick={handlePurge}
        variant="destructive"
        disabled={purging}
        type="button"
      >
        {purging ? (
          <>
            <Spinner className="mr-2 size-3" />
            Purging...
          </>
        ) : (
          <>
            <FontAwesomeIcon icon={faTrash} className="mr-2" />
            Purge Selected Users
          </>
        )}
      </Button>,
    ],
  });

  const stepTitles = {
    criteria: 'Set Purge Criteria',
    preview: 'Select Users to Purge',
    confirm: 'Confirm Purge'
  };

  const stepDescriptions = {
    criteria: 'Configure the criteria for selecting users to purge based on inactivity and other factors.',
    preview: 'Review and select which users you want to remove from your Plex server.',
    confirm: 'Final confirmation before removing the selected users.'
  };

  const { body, footer } =
    step === 'criteria'
      ? renderCriteriaStep()
      : step === 'preview'
      ? renderPreviewStep()
      : renderConfirmStep();

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
    }
  };

  return (
    <ResponsiveDialog
      open={true}
      onOpenChange={handleOpenChange}
      title={stepTitles[step]}
      description={stepDescriptions[step]}
      footer={footer}
      contentClassName="max-w-2xl"
    >
      {body}
    </ResponsiveDialog>
  );
};
