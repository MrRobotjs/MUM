import { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Calendar } from '../ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { useLibraries, type Library } from '../../hooks/useLibraries';
import { useServerOptions } from '../../hooks/useServerOptions';
import { useAlerts } from '../../contexts/AlertContext';
import { requestJson } from '../../util/apiClient';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Spinner } from '@/components/ui/spinner'
import {
  faCalendar,
  faCalendarPlus,
  faCheck,
  faCircleInfo,
  faCog,
  faFolder,
  faInfinity,
  faLink,
  faListCheck,
  faServer,
  faSliders,
  faTrash,
  faTriangleExclamation,
  faUnlock,
  faUsersGear,
} from '@fortawesome/free-solid-svg-icons';

interface MassEditUsersModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedUserIds: Set<string>;
  onComplete?: () => void;
}

interface LibraryChecks {
  [libraryId: string]: boolean;
}

export const MassEditUsersModal = ({ isOpen, onClose, selectedUserIds, onComplete }: MassEditUsersModalProps) => {
  const [action, setAction] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const { success, error } = useAlerts();

  // Modify Libraries state
  const [selectedServerId, setSelectedServerId] = useState<string>('');
  const [libraryChecks, setLibraryChecks] = useState<LibraryChecks>({});
  const [grantAllLibraries, setGrantAllLibraries] = useState(false);
  const [loadingUserLibraries, setLoadingUserLibraries] = useState(false);
  const [userLibraryIds, setUserLibraryIds] = useState<Set<string>>(new Set());
  const [userHasAllLibraries, setUserHasAllLibraries] = useState(false);
  const [libraryChecksInitialized, setLibraryChecksInitialized] = useState(false);

  // Extend Access state
  const [extendDays, setExtendDays] = useState<number>(30);

  // Set Expiration state
  const [expirationDate, setExpirationDate] = useState<Date | undefined>(undefined);

  // Merge Local state
  const [targetLocalUserUuid, setTargetLocalUserUuid] = useState<string>('');

  const { servers } = useServerOptions();
  const { libraries, loading: librariesLoading } = useLibraries({
    serverId: selectedServerId ? Number(selectedServerId) : undefined,
    includeServer: true
  });

  useEffect(() => {
    const loadUserLibraries = async () => {
      if (!isOpen || action !== 'modify_libraries' || !selectedServerId) return;
      if (selectedUserIds.size !== 1) {
        setUserLibraryIds(new Set());
        setUserHasAllLibraries(false);
        setLoadingUserLibraries(false);
        return;
      }

      const [userUuid] = Array.from(selectedUserIds);
      try {
        setLoadingUserLibraries(true);
        const response = await requestJson(`/api/v2/users/${userUuid}`);
        const data = response?.data ?? {};
        const userServerId = data?.server_id ? String(data.server_id) : '';
        if (data?.user_type !== 'service' || (userServerId && userServerId !== selectedServerId)) {
          setUserLibraryIds(new Set());
          setUserHasAllLibraries(false);
          return;
        }

        const allowedIds = new Set<string>((data.allowed_library_ids || []).map((id: string) => String(id)));
        setUserLibraryIds(allowedIds);
        setUserHasAllLibraries(Boolean(data.has_all_libraries));
      } catch {
        setUserLibraryIds(new Set());
        setUserHasAllLibraries(false);
      } finally {
        setLoadingUserLibraries(false);
      }
    };

    loadUserLibraries();
  }, [action, isOpen, selectedServerId, selectedUserIds]);

  useEffect(() => {
    if (action !== 'modify_libraries' || libraryChecksInitialized) return;
    if (librariesLoading || loadingUserLibraries || !selectedServerId) return;
    if (!libraries.length) return;

    const nextChecks: LibraryChecks = {};
    libraries.forEach((library: Library) => {
      const libraryId = getLibraryIdentifier(library);
      nextChecks[libraryId] = userHasAllLibraries ? true : userLibraryIds.has(String(libraryId));
    });
    setLibraryChecks(nextChecks);
    setLibraryChecksInitialized(true);
  }, [
    action,
    libraryChecksInitialized,
    libraries,
    librariesLoading,
    loadingUserLibraries,
    selectedServerId,
    userHasAllLibraries,
    userLibraryIds,
  ]);

  useEffect(() => {
    // Reset state when action changes
    if (action === 'modify_libraries') {
      setLibraryChecks({});
      setGrantAllLibraries(false);
      setUserLibraryIds(new Set());
      setUserHasAllLibraries(false);
      setLibraryChecksInitialized(false);
      setSelectedServerId(servers.length > 0 ? String(servers[0].id) : '');
    } else if (action === 'extend_access') {
      setExtendDays(30);
    } else if (action === 'set_expiration') {
      setExpirationDate(undefined);
    } else if (action === 'merge_local') {
      setTargetLocalUserUuid('');
    }
  }, [action, servers]);

  useEffect(() => {
    if (action !== 'modify_libraries') return;
    setLibraryChecks({});
    setUserLibraryIds(new Set());
    setUserHasAllLibraries(false);
    setLibraryChecksInitialized(false);
  }, [action, selectedServerId]);

  const handleToggleLibrary = (libraryId: string) => {
    setLibraryChecks(prev => ({ ...prev, [libraryId]: !prev[libraryId] }));
  };

  const getLibraryIdentifier = (library: Library): string => {
    const serviceType = library.server?.service_type?.toLowerCase();
    if (serviceType === 'kavita' && library.internal_id) return String(library.internal_id);
    return String(library.external_id ?? library.internal_id ?? library.id);
  };

  const handleSubmit = async () => {
    if (!action) return;

    setSubmitting(true);
    try {
      const userUuids = Array.from(selectedUserIds);

      switch (action) {
        case 'modify_libraries': {
          if (!selectedServerId) {
            error('Please select a server');
            return;
          }

          const operations: any[] = [];
          if (grantAllLibraries) {
            operations.push({ action: 'update_libraries', library_ids: [] });
          } else {
            const selectedLibraryIds = Object.entries(libraryChecks)
              .filter(([_, checked]) => checked)
              .map(([id]) => id);
            operations.push({
              action: 'update_libraries',
              library_ids: selectedLibraryIds,
            });
          }

          await requestJson('/api/v2/users/bulk', {
            method: 'POST',
            body: JSON.stringify({
              user_uuids: userUuids,
              operations
            })
          });

          success(`Updated library access for ${userUuids.length} user${userUuids.length !== 1 ? 's' : ''}`);
          break;
        }

        case 'extend_access': {
          await requestJson('/api/v2/users/bulk', {
            method: 'POST',
            body: JSON.stringify({
              user_uuids: userUuids,
              operations: [{ action: 'extend_access', days: extendDays }]
            })
          });

          success(`Extended access by ${extendDays} days for ${userUuids.length} user${userUuids.length !== 1 ? 's' : ''}`);
          break;
        }

        case 'set_expiration': {
          if (!expirationDate) {
            error('Please select an expiration date');
            return;
          }

          await requestJson('/api/v2/users/bulk', {
            method: 'POST',
            body: JSON.stringify({
              user_uuids: userUuids,
              operations: [{ action: 'set_expiration', expires_at: expirationDate.toISOString() }]
            })
          });

          success(`Set expiration date for ${userUuids.length} user${userUuids.length !== 1 ? 's' : ''}`);
          break;
        }

        case 'clear_expiration': {
          await requestJson('/api/v2/users/bulk', {
            method: 'POST',
            body: JSON.stringify({
              user_uuids: userUuids,
              operations: [{ action: 'clear_expiration' }]
            })
          });

          success(`Cleared expiration date for ${userUuids.length} user${userUuids.length !== 1 ? 's' : ''}`);
          break;
        }

        case 'merge_local': {
          if (!targetLocalUserUuid) {
            error('Please enter a target local user UUID');
            return;
          }

          await requestJson('/api/v2/users/merge', {
            method: 'POST',
            body: JSON.stringify({
              service_user_uuids: userUuids,
              target_local_user_uuid: targetLocalUserUuid
            })
          });

          success(`Merged ${userUuids.length} user${userUuids.length !== 1 ? 's' : ''} into local account`);
          break;
        }

        case 'delete': {
          if (!confirm(`Are you sure you want to permanently delete ${userUuids.length} user${userUuids.length !== 1 ? 's' : ''}? This action cannot be undone.`)) {
            return;
          }

          await requestJson('/api/v2/users/bulk', {
            method: 'POST',
            body: JSON.stringify({
              user_uuids: userUuids,
              operations: [{ action: 'delete_users' }]
            })
          });

          success(`Deleted ${userUuids.length} user${userUuids.length !== 1 ? 's' : ''}`);
          break;
        }

        default:
          error('Unknown action');
          return;
      }

      onComplete?.();
      onClose();
    } catch (err) {
      error(`Failed to ${action.replace('_', ' ')}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSubmitting(false);
    }
  };

  const renderActionContent = () => {
    switch (action) {
      case 'modify_libraries':
        return (
          <div className="space-y-4">
            <div className="bg-blue-50 dark:bg-blue-400/10 rounded-lg p-4 border border-blue-500/30">
              <div className="flex items-start gap-3">
                <FontAwesomeIcon icon={faCircleInfo} className="text-blue-600 dark:text-blue-400 text-lg mt-0.5" />
                <div>
                  <h5 className="font-medium mb-1">Library Access Control</h5>
                  <p className="text-sm text-muted-foreground">
                    Checked libraries indicate current access for the selected user. Uncheck to remove access.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="server">
                <FontAwesomeIcon icon={faServer} className="mr-2" />
                Server
              </Label>
              <Select value={selectedServerId} onValueChange={setSelectedServerId}>
                <SelectTrigger id="server">
                  <SelectValue placeholder="Select a server..." />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((server) => (
                    <SelectItem key={server.id} value={String(server.id)}>
                      {server.server_nickname} ({server.service_type})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="grant-all"
                checked={grantAllLibraries}
                onCheckedChange={(checked) => setGrantAllLibraries(checked === true)}
              />
              <Label htmlFor="grant-all" className="cursor-pointer">
                <FontAwesomeIcon icon={faUnlock} className="mr-2" />
                Grant access to all libraries
              </Label>
            </div>

            {!grantAllLibraries && selectedServerId && (
              <div className="space-y-2">
                <Label>
                  <FontAwesomeIcon icon={faFolder} className="mr-2" />
                  Select Libraries
                </Label>
                  <div className="max-h-64 overflow-y-auto border rounded-lg p-3 space-y-2">
                    {librariesLoading || loadingUserLibraries ? (
                      <div className="flex items-center justify-center py-4">
                        <Spinner className="size-4" />
                      </div>
                    ) : libraries.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        No libraries found for this server
                      </p>
                    ) : (
                      libraries.map((library: Library) => {
                        const libraryId = getLibraryIdentifier(library);
                        const isChecked = !!libraryChecks[libraryId];
                        return (
                          <label
                            key={libraryId}
                            className="flex items-center gap-3 p-2 rounded hover:bg-muted cursor-pointer"
                          >
                            <Checkbox
                              checked={isChecked}
                              onCheckedChange={() => handleToggleLibrary(libraryId)}
                            />
                            <div className="flex-1">
                              <div className="font-medium text-sm">{library.name}</div>
                              {library.library_type && (
                                <div className="text-xs text-muted-foreground">{library.library_type}</div>
                              )}
                            </div>
                          </label>
                      )})
                    )}
                  </div>
                  {selectedUserIds.size !== 1 && (
                    <p className="text-xs text-muted-foreground">
                      Multiple users selected — checkboxes don’t reflect per-user access.
                    </p>
                  )}
                  {selectedUserIds.size === 1 && userHasAllLibraries && (
                    <p className="text-xs text-muted-foreground">
                      This user currently has access to all libraries.
                    </p>
                  )}
                </div>
              )}
          </div>
        );

      case 'extend_access':
        return (
          <div className="space-y-4">
            <div className="bg-blue-50 dark:bg-blue-400/10 rounded-lg p-4 border border-blue-500/30">
              <div className="flex items-start gap-3">
                <FontAwesomeIcon icon={faCircleInfo} className="text-blue-600 dark:text-blue-400 text-lg mt-0.5" />
                <div>
                  <h5 className="font-medium mb-1">Extend Access Duration</h5>
                  <p className="text-sm text-muted-foreground">
                    Add days to the current expiration date of selected users. If a user has no expiration date, it will be set to today + specified days.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="extend-days">
                <FontAwesomeIcon icon={faCalendarPlus} className="mr-2" />
                Number of Days to Add
              </Label>
              <Input
                id="extend-days"
                type="number"
                min="1"
                max="3650"
                value={extendDays}
                onChange={(e) => setExtendDays(Math.max(1, parseInt(e.target.value) || 0))}
              />
              <p className="text-sm text-muted-foreground">
                Expiration dates will be extended by {extendDays} day{extendDays !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
        );

      case 'set_expiration':
        return (
          <div className="space-y-4">
            <div className="bg-blue-50 dark:bg-blue-400/10 rounded-lg p-4 border border-blue-500/30">
              <div className="flex items-start gap-3">
                <FontAwesomeIcon icon={faCircleInfo} className="text-blue-600 dark:text-blue-400 text-lg mt-0.5" />
                <div>
                  <h5 className="font-medium mb-1">Set Expiration Date</h5>
                  <p className="text-sm text-muted-foreground">
                    Set a specific expiration date for all selected users. This will override any existing expiration dates.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>
                <FontAwesomeIcon icon={faCalendar} className="mr-2" />
                Expiration Date
              </Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start text-left font-normal">
                    <FontAwesomeIcon icon={faCalendar} className="mr-2" />
                    {expirationDate ? expirationDate.toLocaleDateString() : 'Select date...'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={expirationDate}
                    onSelect={setExpirationDate}
                    disabled={(date) => date < new Date()}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              {expirationDate && (
                <p className="text-sm text-muted-foreground">
                  Users will lose access on {expirationDate.toLocaleDateString()}
                </p>
              )}
            </div>
          </div>
        );

      case 'clear_expiration':
        return (
          <div className="space-y-4">
            <div className="bg-amber-50 dark:bg-amber-400/10 rounded-lg p-4 border border-amber-500/30">
              <div className="flex items-start gap-3">
                <FontAwesomeIcon icon={faTriangleExclamation} className="text-amber-600 dark:text-amber-400 text-lg mt-0.5" />
                <div>
                  <h5 className="font-medium mb-1">Clear Expiration Date</h5>
                  <p className="text-sm text-muted-foreground">
                    Remove expiration dates from all selected users. They will have indefinite access until a new expiration date is set.
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-muted/50 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <FontAwesomeIcon icon={faInfinity} className="text-primary text-2xl" />
                <div>
                  <p className="font-medium">Indefinite Access</p>
                  <p className="text-sm text-muted-foreground">
                    {selectedUserIds.size} user{selectedUserIds.size !== 1 ? 's' : ''} will have no expiration date
                  </p>
                </div>
              </div>
            </div>
          </div>
        );

      case 'merge_local':
        return (
          <div className="space-y-4">
            <div className="bg-blue-50 dark:bg-blue-400/10 rounded-lg p-4 border border-blue-500/30">
              <div className="flex items-start gap-3">
                <FontAwesomeIcon icon={faCircleInfo} className="text-blue-600 dark:text-blue-400 text-lg mt-0.5" />
                <div>
                  <h5 className="font-medium mb-1">Merge into Local Account</h5>
                  <p className="text-sm text-muted-foreground">
                    Link all selected service users to a single local account. This is useful for consolidating multiple service accounts under one user.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="target-uuid">
                <FontAwesomeIcon icon={faLink} className="mr-2" />
                Target Local User UUID
              </Label>
              <Input
                id="target-uuid"
                type="text"
                placeholder="Enter local user UUID..."
                value={targetLocalUserUuid}
                onChange={(e) => setTargetLocalUserUuid(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                All {selectedUserIds.size} service user{selectedUserIds.size !== 1 ? 's' : ''} will be linked to this local account
              </p>
            </div>
          </div>
        );

      case 'delete':
        return (
          <div className="space-y-4">
            <div className="bg-destructive/10 rounded-lg p-4 border border-destructive/30">
              <div className="flex items-start gap-3">
                <FontAwesomeIcon icon={faTriangleExclamation} className="text-destructive text-lg mt-0.5" />
                <div>
                  <h5 className="font-medium mb-1 text-destructive">Permanent Deletion</h5>
                  <p className="text-sm text-muted-foreground">
                    This will permanently delete {selectedUserIds.size} user{selectedUserIds.size !== 1 ? 's' : ''} and all associated data. This action cannot be undone.
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-muted/50 rounded-lg p-4">
              <div className="space-y-2 text-sm">
                <p className="font-medium">The following will be deleted:</p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>User accounts and profiles</li>
                  <li>Service account connections</li>
                  <li>Library access permissions</li>
                  <li>Activity history and logs</li>
                  <li>Custom settings and preferences</li>
                </ul>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
    }
  };

  const modalBody = (
    <div className="space-y-6 py-4">
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <FontAwesomeIcon icon={faCog} className="text-primary text-sm" />
          <h4 className="font-medium text-lg">Select Action</h4>
        </div>

        <div className="bg-muted/50 rounded-lg p-4 border">
          <div className="space-y-2">
            <Label htmlFor="action">
              <FontAwesomeIcon icon={faListCheck} className="text-primary text-sm mr-2" />
              Action to Perform
            </Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger id="action">
                <SelectValue placeholder="Choose an action..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="modify_libraries">
                  <FontAwesomeIcon icon={faFolder} className="mr-2" />
                  Modify Library Access
                </SelectItem>
                <SelectItem value="extend_access">
                  <FontAwesomeIcon icon={faCalendarPlus} className="mr-2" />
                  Extend Access Duration
                </SelectItem>
                <SelectItem value="set_expiration">
                  <FontAwesomeIcon icon={faCalendar} className="mr-2" />
                  Set Expiration Date
                </SelectItem>
                <SelectItem value="clear_expiration">
                  <FontAwesomeIcon icon={faInfinity} className="mr-2" />
                  Clear Expiration Date
                </SelectItem>
                <SelectItem value="merge_local">
                  <FontAwesomeIcon icon={faLink} className="mr-2" />
                  Merge into Local Account
                </SelectItem>
                <SelectItem value="delete">
                  <FontAwesomeIcon icon={faTrash} className="mr-2" />
                  Delete Users
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              Choose what action to perform on the selected users
            </p>
          </div>
        </div>
      </div>

      {action && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faSliders} className="text-primary text-sm" />
            <h4 className="font-medium text-lg">Configure Action</h4>
          </div>
          {renderActionContent()}
        </div>
      )}
    </div>
  );

  const footer = [
    <Button key="cancel" onClick={onClose} variant="outline" disabled={submitting}>
      Cancel
    </Button>,
    <Button
      key="submit"
      onClick={handleSubmit}
      disabled={!action || submitting}
      variant={action === 'delete' ? 'destructive' : 'default'}
    >
      {submitting ? (
        <>
          <Spinner className="mr-2 size-3" />
          Processing...
        </>
      ) : (
        <>
          <FontAwesomeIcon icon={action === 'delete' ? faTrash : faCheck} className="mr-2" />
          Apply Changes
        </>
      )}
    </Button>,
  ];

  return (
    <ResponsiveDialog
      open={isOpen}
      onOpenChange={handleOpenChange}
      title={
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
            <FontAwesomeIcon icon={faUsersGear} className="text-primary text-lg" />
          </div>
          <span>Mass Edit Users</span>
        </div>
      }
      description={`Apply changes to ${selectedUserIds.size} selected user${selectedUserIds.size !== 1 ? 's' : ''} at once`}
      footer={footer}
      contentClassName="max-w-3xl"
      bodyClassName="pt-2"
    >
      {modalBody}
    </ResponsiveDialog>
  );
};
