import { useState, type ReactNode } from 'react';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { requestJson } from '../../util/apiClient';
import { useAlerts } from '../../contexts/AlertContext';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { Alert, AlertDescription } from '../ui/alert';
import { ResponsiveDialog } from '../ui/responsive-dialog';

interface EligibleUser {
  uuid: string;
  username?: string;
  email?: string;
  server_name?: string;
  service_type?: string;
  avatar_url?: string;
  created_at?: string;
  last_streamed_at?: string | null;
  last_login_at?: string | null;
  days_since_activity?: number;
  is_sharer?: boolean;
  is_whitelisted?: boolean;
}

interface PurgeCriteria {
  inactive_days: number;
  exclude_sharers: boolean;
  exclude_whitelisted: boolean;
  ignore_creation_date: boolean;
}

interface PurgeUsersModalProps {
  onClose: () => void;
  onPurgeComplete?: () => void;
}

export const PurgeUsersModal = ({ onClose, onPurgeComplete }: PurgeUsersModalProps) => {
  const [step, setStep] = useState<'criteria' | 'preview' | 'confirm'>('criteria');
  const [loading, setLoading] = useState(false);
  const [purging, setPurging] = useState(false);
  const { success, error } = useAlerts();

  // Criteria state
  const [inactiveDays, setInactiveDays] = useState(180);
  const [excludeSharers, setExcludeSharers] = useState(true);
  const [excludeWhitelisted, setExcludeWhitelisted] = useState(true);
  const [ignoreCreationDate, setIgnoreCreationDate] = useState(false);

  // Preview state
  const [eligibleUsers, setEligibleUsers] = useState<EligibleUser[]>([]);
  const [selectedUserUuids, setSelectedUserUuids] = useState<Set<string>>(new Set());

  const handlePreview = async () => {
    setLoading(true);
    try {
      const result = await requestJson<{
        data: {
          users: EligibleUser[];
          criteria: PurgeCriteria;
        };
      }>(`/admin/api/v2/users/eligible-for-purge?inactive_days=${inactiveDays}&exclude_sharers=${excludeSharers}&exclude_whitelisted=${excludeWhitelisted}&ignore_creation_date=${ignoreCreationDate}`);

      const users = result.data.users;
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
      const result = await requestJson<{
        data: {
          deleted: number;
          failed: number;
          message: string;
        };
      }>('/admin/api/v2/users/purge', {
        method: 'POST',
        body: JSON.stringify({
          user_uuids: Array.from(selectedUserUuids),
          criteria: {
            inactive_days: inactiveDays,
            exclude_sharers: excludeSharers,
            exclude_whitelisted: excludeWhitelisted,
            ignore_creation_date: ignoreCreationDate
          }
        })
      });

      const { deleted, failed } = result.data;

      if (failed === 0) {
        success(`Successfully purged ${deleted} user${deleted !== 1 ? 's' : ''}.`);
      } else {
        error(`Purged ${deleted} user${deleted !== 1 ? 's' : ''} with ${failed} error${failed !== 1 ? 's' : ''}.`);
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
          <IconAlertTriangle />
          <AlertDescription>
            This will permanently delete selected users and all their associated data. This action cannot be undone.
          </AlertDescription>
        </Alert>

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
            Users who haven't logged in or streamed in this many days
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="exclude-sharers"
            checked={excludeSharers}
            onCheckedChange={setExcludeSharers}
          />
          <Label htmlFor="exclude-sharers" className="cursor-pointer">
            Exclude users who share back
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="exclude-whitelisted"
            checked={excludeWhitelisted}
            onCheckedChange={setExcludeWhitelisted}
          />
          <Label htmlFor="exclude-whitelisted" className="cursor-pointer">
            Exclude whitelisted users
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="ignore-creation-date"
            checked={ignoreCreationDate}
            onCheckedChange={setIgnoreCreationDate}
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
            <span className="loading loading-spinner loading-xs mr-2" />
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
          <IconInfoCircle />
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
                  {user.days_since_activity !== undefined && (
                    <span>{user.days_since_activity} days inactive</span>
                  )}
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
          <IconAlertTriangle />
          <AlertDescription>
            <p className="font-semibold">Final Confirmation</p>
            <p className="text-sm">
              You are about to permanently delete {selectedUserUuids.size} user{selectedUserUuids.size !== 1 ? 's' : ''}.
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
            <span className="loading loading-spinner loading-xs mr-2" />
            Purging...
          </>
        ) : (
          <>
            <i className="fa-solid fa-trash mr-2" />
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
    preview: 'Review and select which users you want to permanently delete from the system.',
    confirm: 'Final confirmation before permanently deleting the selected users.'
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
