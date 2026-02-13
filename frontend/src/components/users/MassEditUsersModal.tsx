import { useState, useEffect, useMemo } from 'react';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
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

interface LocalLinkUserOption {
  uuid: string;
  displayName: string;
  username?: string | null;
  email?: string | null;
  userType: 'local' | 'owner';
}

interface ServiceLinkOption {
  uuid: string;
  displayName: string;
  serviceType?: string | null;
  serverName?: string | null;
  email?: string | null;
  linkedLocalName?: string | null;
  selectable: boolean;
  fromSelection: boolean;
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
  const [expirationMode, setExpirationMode] = useState<'set' | 'extend' | 'clear'>('set');

  // Local link state
  const [targetLocalUserUuid, setTargetLocalUserUuid] = useState<string>('');
  const [localLinkMode, setLocalLinkMode] = useState<'link' | 'unlink'>('link');
  const [localUsers, setLocalUsers] = useState<LocalLinkUserOption[]>([]);
  const [serviceLinkOptions, setServiceLinkOptions] = useState<ServiceLinkOption[]>([]);
  const [selectedServiceUserUuids, setSelectedServiceUserUuids] = useState<Set<string>>(new Set());
  const [selectionLocalUsers, setSelectionLocalUsers] = useState<LocalLinkUserOption[]>([]);
  const [selectionServiceUsers, setSelectionServiceUsers] = useState<ServiceLinkOption[]>([]);
  const [loadingLinkContext, setLoadingLinkContext] = useState(false);
  const [loadingLocalUsers, setLoadingLocalUsers] = useState(false);
  const [loadingServiceOptions, setLoadingServiceOptions] = useState(false);
  const [linkContextError, setLinkContextError] = useState<string | null>(null);
  const [localUsersError, setLocalUsersError] = useState<string | null>(null);
  const [serviceOptionsError, setServiceOptionsError] = useState<string | null>(null);
  const [multipleLocalUsersSelected, setMultipleLocalUsersSelected] = useState(false);
  const [localUserSearch, setLocalUserSearch] = useState('');
  const [serviceUserSearch, setServiceUserSearch] = useState('');

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
    } else if (action === 'manage_expiration') {
      setExpirationMode('set');
      setExpirationDate(undefined);
      setExtendDays(30);
    } else if (action === 'manage_local_link') {
      setTargetLocalUserUuid('');
      setLocalLinkMode('link');
      setSelectedServiceUserUuids(new Set());
      setSelectionLocalUsers([]);
      setSelectionServiceUsers([]);
      setServiceLinkOptions([]);
      setMultipleLocalUsersSelected(false);
      setLocalUserSearch('');
      setServiceUserSearch('');
      setLinkContextError(null);
      setServiceOptionsError(null);
    }
  }, [action, servers]);

  useEffect(() => {
    if (action !== 'modify_libraries') return;
    setLibraryChecks({});
    setUserLibraryIds(new Set());
    setUserHasAllLibraries(false);
    setLibraryChecksInitialized(false);
  }, [action, selectedServerId]);

  const getDisplayName = (data: {
    display_name?: string | null;
    username?: string | null;
    local_username?: string | null;
    external_username?: string | null;
    external_email?: string | null;
    email?: string | null;
  }) => {
    return (
      data.display_name ||
      data.username ||
      data.local_username ||
      data.external_username ||
      data.external_email ||
      data.email ||
      'Unknown User'
    );
  };

  useEffect(() => {
    if (!isOpen || action !== 'manage_local_link' || localLinkMode !== 'link') return;

    let cancelled = false;

    const loadLocalUsers = async () => {
      setLoadingLocalUsers(true);
      setLocalUsersError(null);
      try {
        type UserListResponse = {
          data: Array<{
            uuid: string;
            display_name?: string | null;
            username?: string | null;
            email?: string | null;
            external_email?: string | null;
            user_type: string;
          }>;
        };

        const [localsResponse, ownersResponse] = await Promise.all([
          requestJson<UserListResponse>('/api/v2/users?user_type=local&page_size=100&sort=username_asc'),
          requestJson<UserListResponse>('/api/v2/users?user_type=owner&page_size=100&sort=username_asc'),
        ]);

        if (cancelled) return;

        const deduped = new Map<string, LocalLinkUserOption>();
        [...(localsResponse.data ?? []), ...(ownersResponse.data ?? [])].forEach((user) => {
          deduped.set(user.uuid, {
            uuid: user.uuid,
            displayName: getDisplayName(user),
            username: user.username ?? null,
            email: user.email ?? user.external_email ?? null,
            userType: user.user_type?.toLowerCase() === 'owner' ? 'owner' : 'local',
          });
        });

        const sorted = Array.from(deduped.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
        setLocalUsers(sorted);
      } catch (err) {
        setLocalUsersError(err instanceof Error ? err.message : 'Failed to load local users.');
      } finally {
        if (!cancelled) {
          setLoadingLocalUsers(false);
        }
      }
    };

    loadLocalUsers();

    return () => {
      cancelled = true;
    };
  }, [isOpen, action, localLinkMode]);

  useEffect(() => {
    if (!isOpen || action !== 'manage_local_link' || localLinkMode !== 'link') return;

    let cancelled = false;

    const loadSelectionContext = async () => {
      if (selectedUserIds.size === 0) {
        setSelectionLocalUsers([]);
        setSelectionServiceUsers([]);
        setSelectedServiceUserUuids(new Set());
        setMultipleLocalUsersSelected(false);
        return;
      }

      setLoadingLinkContext(true);
      setLinkContextError(null);
      try {
        const selectedUuids = Array.from(selectedUserIds);
        const selectedDetails = await Promise.all(
          selectedUuids.map(async (uuid) => {
            try {
              const response = await requestJson<{ data: any }>(`/api/v2/users/${uuid}`);
              return response?.data ?? null;
            } catch {
              return null;
            }
          })
        );

        if (cancelled) return;

        const locals: LocalLinkUserOption[] = [];
        const services: ServiceLinkOption[] = [];

        selectedDetails.forEach((detail) => {
          if (!detail) return;
          const userType = String(detail.user_type ?? '').toLowerCase();
          if (userType === 'local' || userType === 'owner') {
            locals.push({
              uuid: detail.uuid,
              displayName: getDisplayName(detail),
              username: detail.username ?? detail.local_username ?? null,
              email: detail.email ?? detail.external_email ?? null,
              userType: userType === 'owner' ? 'owner' : 'local',
            });
            return;
          }
          if (userType === 'service') {
            services.push({
              uuid: detail.uuid,
              displayName: getDisplayName(detail),
              serviceType: detail.service_type ?? null,
              serverName: detail.server_nickname ?? null,
              email: detail.external_email ?? detail.email ?? null,
              linkedLocalName: detail.linked_local_user?.display_name ?? detail.linked_local_user?.username ?? null,
              selectable: !detail.linked_local_user,
              fromSelection: true,
            });
          }
        });

        setSelectionLocalUsers(locals);
        setSelectionServiceUsers(services);
        setSelectedServiceUserUuids(
          new Set(services.filter((service) => service.selectable).map((service) => service.uuid))
        );
        setMultipleLocalUsersSelected(locals.length > 1);

        if (locals.length === 1) {
          setTargetLocalUserUuid(locals[0].uuid);
        } else if (locals.length === 0) {
          setTargetLocalUserUuid('');
        } else {
          setTargetLocalUserUuid('');
        }
      } catch (err) {
        setLinkContextError(err instanceof Error ? err.message : 'Failed to evaluate current selection.');
      } finally {
        if (!cancelled) {
          setLoadingLinkContext(false);
        }
      }
    };

    loadSelectionContext();

    return () => {
      cancelled = true;
    };
  }, [isOpen, action, localLinkMode, selectedUserIds]);

  useEffect(() => {
    if (!isOpen || action !== 'manage_local_link' || localLinkMode !== 'link') return;

    let cancelled = false;

    const loadServiceOptions = async () => {
      setServiceOptionsError(null);
      setLoadingServiceOptions(true);

      try {
        type AvailableServiceResponse = {
          data: Array<{
            uuid: string;
            service_type?: string | null;
            server_name?: string | null;
            external_username?: string | null;
            external_email?: string | null;
          }>;
        };

        const response = await requestJson<AvailableServiceResponse>(
          '/api/v2/users/service-accounts/available'
        );
        if (cancelled) return;

        const merged = new Map<string, ServiceLinkOption>();
        (response.data ?? []).forEach((service) => {
          merged.set(service.uuid, {
            uuid: service.uuid,
            displayName: service.external_username || service.external_email || 'Service User',
            serviceType: service.service_type ?? null,
            serverName: service.server_name ?? null,
            email: service.external_email ?? null,
            linkedLocalName: null,
            selectable: true,
            fromSelection: false,
          });
        });

        selectionServiceUsers.forEach((service) => {
          const existing = merged.get(service.uuid);
          if (existing) {
            merged.set(service.uuid, { ...existing, fromSelection: true });
            return;
          }

          merged.set(service.uuid, {
            ...service,
            selectable: !service.linkedLocalName,
            fromSelection: true,
          });
        });

        setServiceLinkOptions(Array.from(merged.values()));
      } catch (err) {
        setServiceOptionsError(err instanceof Error ? err.message : 'Failed to load unlinked service users.');
        setServiceLinkOptions(selectionServiceUsers);
      } finally {
        if (!cancelled) {
          setLoadingServiceOptions(false);
        }
      }
    };

    loadServiceOptions();

    return () => {
      cancelled = true;
    };
  }, [isOpen, action, localLinkMode, selectionServiceUsers]);

  useEffect(() => {
    if (action !== 'manage_local_link' || localLinkMode !== 'link') return;
    const selectableIds = new Set(
      serviceLinkOptions.filter((service) => service.selectable).map((service) => service.uuid)
    );
    setSelectedServiceUserUuids((prev) => {
      const next = new Set<string>();
      prev.forEach((uuid) => {
        if (selectableIds.has(uuid)) next.add(uuid);
      });
      return next;
    });
  }, [action, localLinkMode, serviceLinkOptions]);

  const filteredLocalUsers = useMemo(() => {
    const query = localUserSearch.trim().toLowerCase();
    const base = !query
      ? localUsers
      : localUsers.filter((localUser) =>
          [localUser.displayName, localUser.username ?? '', localUser.email ?? '']
            .join(' ')
            .toLowerCase()
            .includes(query)
        );

    if (!targetLocalUserUuid) {
      return base;
    }

    return [...base].sort((a, b) => {
      if (a.uuid === targetLocalUserUuid) return -1;
      if (b.uuid === targetLocalUserUuid) return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [localUsers, localUserSearch, targetLocalUserUuid]);

  const filteredServiceOptions = useMemo(() => {
    const query = serviceUserSearch.trim().toLowerCase();
    const base = !query
      ? serviceLinkOptions
      : serviceLinkOptions.filter((service) =>
          [service.displayName, service.serviceType ?? '', service.serverName ?? '', service.email ?? '']
            .join(' ')
            .toLowerCase()
            .includes(query)
        );

    return [...base].sort((a, b) => {
      if (a.fromSelection !== b.fromSelection) {
        return a.fromSelection ? -1 : 1;
      }
      return a.displayName.localeCompare(b.displayName);
    });
  }, [serviceLinkOptions, serviceUserSearch]);

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

        case 'manage_expiration': {
          if (expirationMode === 'extend') {
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

          if (expirationMode === 'set') {
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

        case 'manage_local_link': {
          if (localLinkMode === 'unlink') {
            await requestJson('/api/v2/users/bulk', {
              method: 'POST',
              body: JSON.stringify({
                user_uuids: userUuids,
                operations: [{ action: 'unlink_local' }]
              })
            });

            success(`Unlinked ${userUuids.length} user${userUuids.length !== 1 ? 's' : ''} from local account`);
            break;
          }

          if (multipleLocalUsersSelected) {
            error('Multiple local users are selected. Please select exactly one local user in the main list and try again.');
            return;
          }

          if (!targetLocalUserUuid) {
            error('Please select a local user');
            return;
          }

          const serviceUserUuids = Array.from(selectedServiceUserUuids);
          if (serviceUserUuids.length === 0) {
            error('Please select at least one service user to link');
            return;
          }

          await requestJson('/api/v2/users/merge', {
            method: 'POST',
            body: JSON.stringify({
              service_user_uuids: serviceUserUuids,
              target_local_user_uuid: targetLocalUserUuid
            })
          });

          success(`Linked ${serviceUserUuids.length} user${serviceUserUuids.length !== 1 ? 's' : ''} to local account`);
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
            <Alert variant="info">
              <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
              <AlertTitle>Library Access Control</AlertTitle>
              <AlertDescription>
                Checked libraries indicate current access for the selected user. Uncheck to remove access.
              </AlertDescription>
            </Alert>

            <div className="space-y-2">
              <Label htmlFor="server">
                <FontAwesomeIcon icon={faServer} className="mr-2" />
                Server
              </Label>
              <Select value={selectedServerId} onValueChange={setSelectedServerId}>
                <SelectTrigger id="server" className="h-11">
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

      case 'manage_expiration':
        return (
          <div className="space-y-4">
            <Alert variant={expirationMode === 'clear' ? 'warning' : 'info'}>
              <FontAwesomeIcon
                icon={
                  expirationMode === 'set'
                    ? faCircleInfo
                    : expirationMode === 'extend'
                      ? faCalendarPlus
                      : faTriangleExclamation
                }
                className="h-4 w-4"
              />
              <AlertTitle>
                {expirationMode === 'set'
                  ? 'Set Expiration Date'
                  : expirationMode === 'extend'
                    ? 'Extend Access Duration'
                    : 'Clear Expiration Date'}
              </AlertTitle>
              <AlertDescription>
                {expirationMode === 'set'
                  ? 'Set a specific expiration date for all selected users. This will override any existing expiration dates.'
                  : expirationMode === 'extend'
                    ? 'Add days to the current expiration date of selected users. If a user has no expiration date, it will be set to today + specified days.'
                    : 'Remove expiration dates from all selected users. They will have indefinite access until a new expiration date is set.'}
              </AlertDescription>
            </Alert>

            <div className="space-y-2">
              <Label htmlFor="expiration-mode">Expiration Action</Label>
              <Select
                value={expirationMode}
                onValueChange={(value: 'set' | 'extend' | 'clear') => setExpirationMode(value)}
              >
                <SelectTrigger id="expiration-mode" className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="set">
                    <FontAwesomeIcon icon={faCalendar} className="mr-2" />
                    Set expiration date
                  </SelectItem>
                  <SelectItem value="extend">
                    <FontAwesomeIcon icon={faCalendarPlus} className="mr-2" />
                    Extend access duration
                  </SelectItem>
                  <SelectItem value="clear">
                    <FontAwesomeIcon icon={faInfinity} className="mr-2" />
                    Clear expiration date
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {expirationMode === 'set' ? (
              <div className="space-y-2">
                <Label>
                  <FontAwesomeIcon icon={faCalendar} className="mr-2" />
                  Expiration Date
                </Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="h-11 w-full justify-start text-left font-normal">
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
            ) : expirationMode === 'extend' ? (
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
                  className="h-11"
                />
                <p className="text-sm text-muted-foreground">
                  Expiration dates will be extended by {extendDays} day{extendDays !== 1 ? 's' : ''}
                </p>
              </div>
            ) : (
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
            )}
          </div>
        );

      case 'manage_local_link':
        return (
          <div className="space-y-4">
            <Alert variant={localLinkMode === 'unlink' ? 'warning' : 'info'}>
              <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
              <AlertTitle>
                {localLinkMode === 'link' ? 'Link to Local Account' : 'Unlink from Local Account'}
              </AlertTitle>
              <AlertDescription>
                {localLinkMode === 'link'
                  ? 'Link all selected service users to a single local account. This is useful for consolidating multiple service accounts under one user.'
                  : 'Remove local-account links from the selected service users. This only affects linking and does not delete users.'}
              </AlertDescription>
            </Alert>

            <div className="space-y-2">
              <Label htmlFor="local-link-mode">Link Action</Label>
              <Select
                value={localLinkMode}
                onValueChange={(value: 'link' | 'unlink') => setLocalLinkMode(value)}
              >
                <SelectTrigger id="local-link-mode" className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="link">
                    <FontAwesomeIcon icon={faLink} className="mr-2" />
                    Link to local account
                  </SelectItem>
                  <SelectItem value="unlink">
                    <FontAwesomeIcon icon={faLink} className="mr-2" />
                    Unlink from local account
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {localLinkMode === 'link' ? (
              <div className="space-y-4">
                {multipleLocalUsersSelected && (
                  <Alert variant="warning">
                    <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
                    <AlertTitle>Multiple Local Users Selected</AlertTitle>
                    <AlertDescription>
                      Select exactly one local user in the main list before linking service users.
                    </AlertDescription>
                  </Alert>
                )}

                {linkContextError && (
                  <Alert variant="warning">
                    <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
                    <AlertTitle>Selection Context Unavailable</AlertTitle>
                    <AlertDescription>{linkContextError}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label>Local User</Label>
                  <Input
                    placeholder="Search local users..."
                    value={localUserSearch}
                    onChange={(event) => setLocalUserSearch(event.target.value)}
                    className="h-11"
                  />
                  <div className="max-h-56 overflow-y-auto rounded-lg border p-2 space-y-1">
                    {loadingLocalUsers || loadingLinkContext ? (
                      <div className="flex items-center justify-center py-4">
                        <Spinner className="size-4" />
                      </div>
                    ) : localUsersError ? (
                      <p className="px-2 py-3 text-sm text-destructive">{localUsersError}</p>
                    ) : filteredLocalUsers.length === 0 ? (
                      <p className="px-2 py-3 text-sm text-muted-foreground">No local users found.</p>
                    ) : (
                      filteredLocalUsers.map((localUser) => {
                        const selected = localUser.uuid === targetLocalUserUuid;
                        const otherLocalDisabled = Boolean(targetLocalUserUuid) && !selected;
                        return (
                          <label
                            key={localUser.uuid}
                            className={`flex items-start gap-3 rounded-md border px-3 py-2 ${
                              selected
                                ? 'cursor-pointer border-primary bg-primary/10'
                                : otherLocalDisabled
                                  ? 'cursor-not-allowed border-border/50 bg-muted/30'
                                  : 'cursor-pointer border-border bg-card hover:border-border/70'
                            }`}
                          >
                            <Checkbox
                              checked={selected}
                              disabled={otherLocalDisabled}
                              onCheckedChange={(isChecked) => {
                                if (isChecked === true) {
                                  setTargetLocalUserUuid(localUser.uuid);
                                } else if (selected) {
                                  setTargetLocalUserUuid('');
                                }
                              }}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium truncate">{localUser.displayName}</div>
                              <div className="text-xs text-muted-foreground">
                                {localUser.userType === 'owner' ? 'Owner' : 'Local'} · {localUser.username || localUser.email || localUser.uuid}
                              </div>
                            </div>
                          </label>
                        );
                      })
                    )}
                  </div>
                  {selectionLocalUsers.length === 1 && targetLocalUserUuid === selectionLocalUsers[0].uuid && (
                    <p className="text-xs text-muted-foreground">
                      Preselected from current selection: {selectionLocalUsers[0].displayName}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Service Users</Label>
                  <Input
                    placeholder="Search service users..."
                    value={serviceUserSearch}
                    onChange={(event) => setServiceUserSearch(event.target.value)}
                    className="h-11"
                  />
                  <div className="max-h-64 overflow-y-auto rounded-lg border p-2 space-y-1">
                    {loadingServiceOptions ? (
                      <div className="flex items-center justify-center py-4">
                        <Spinner className="size-4" />
                      </div>
                    ) : serviceOptionsError ? (
                      <p className="px-2 py-3 text-sm text-destructive">{serviceOptionsError}</p>
                    ) : filteredServiceOptions.length === 0 ? (
                      <p className="px-2 py-3 text-sm text-muted-foreground">
                        No eligible service users available.
                      </p>
                    ) : (
                      filteredServiceOptions.map((serviceUser) => {
                        const checked = selectedServiceUserUuids.has(serviceUser.uuid);
                        return (
                          <label
                            key={serviceUser.uuid}
                            className={`flex items-start gap-3 rounded-md border px-3 py-2 ${
                              serviceUser.selectable
                                ? 'cursor-pointer border-border bg-card hover:border-border/70'
                                : 'cursor-not-allowed border-border/50 bg-muted/30'
                            }`}
                          >
                            <Checkbox
                              checked={checked}
                              disabled={!serviceUser.selectable}
                              onCheckedChange={(isChecked) => {
                                setSelectedServiceUserUuids((prev) => {
                                  const next = new Set(prev);
                                  if (isChecked === true) {
                                    next.add(serviceUser.uuid);
                                  } else {
                                    next.delete(serviceUser.uuid);
                                  }
                                  return next;
                                });
                              }}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium truncate">{serviceUser.displayName}</div>
                              <div className="text-xs text-muted-foreground">
                                {(serviceUser.serviceType || 'Service').toUpperCase()}
                                {serviceUser.serverName ? ` · ${serviceUser.serverName}` : ''}
                              </div>
                              {!serviceUser.selectable && serviceUser.linkedLocalName && (
                                <div className="text-[11px] text-amber-600 dark:text-amber-400">
                                  Already linked to {serviceUser.linkedLocalName}
                                </div>
                              )}
                              {serviceUser.fromSelection && (
                                <div className="text-[11px] text-muted-foreground">From current selection</div>
                              )}
                            </div>
                          </label>
                        );
                      })
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Selected: {selectedServiceUserUuids.size} service user{selectedServiceUserUuids.size !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>
            ) : (
              <div className="bg-muted/50 rounded-lg p-4">
                <div className="flex items-center gap-3">
                  <FontAwesomeIcon icon={faLink} className="text-primary text-lg" />
                  <div>
                    <p className="font-medium">Unlink Selected Users</p>
                    <p className="text-sm text-muted-foreground">
                      {selectedUserIds.size} selected user{selectedUserIds.size !== 1 ? 's' : ''} will be unlinked from their local account
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        );

      case 'delete':
        return (
          <div className="space-y-4">
            <Alert variant="destructive">
              <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
              <AlertTitle>Permanent Deletion</AlertTitle>
              <AlertDescription>
                This will permanently delete {selectedUserIds.size} user{selectedUserIds.size !== 1 ? 's' : ''} and all associated data. This action cannot be undone.
              </AlertDescription>
            </Alert>

            <div className="rounded-lg border border-border bg-muted/40 p-4">
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
      <Alert variant="info">
        <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
        <AlertTitle>Mass Edit Operations</AlertTitle>
        <AlertDescription>
          Apply one operation to all selected users at once. Review the action settings carefully before submitting.
        </AlertDescription>
      </Alert>

      <div className="space-y-4">
        <h4 className="flex items-center gap-2 text-lg font-medium">
          <FontAwesomeIcon icon={faCog} className="text-sm text-primary" />
          Select Action
        </h4>

        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="space-y-2">
            <Label htmlFor="action">
              <FontAwesomeIcon icon={faListCheck} className="text-primary text-sm mr-2" />
              Action to Perform
            </Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger id="action" className="h-11">
                <SelectValue placeholder="Choose an action..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="modify_libraries">
                  <FontAwesomeIcon icon={faFolder} className="mr-2" />
                  Modify Library Access
                </SelectItem>
                <SelectItem value="manage_expiration">
                  <FontAwesomeIcon icon={faCalendar} className="mr-2" />
                  Manage Expiration
                </SelectItem>
                <SelectItem value="manage_local_link">
                  <FontAwesomeIcon icon={faLink} className="mr-2" />
                  Manage Local Account Link
                </SelectItem>
                <SelectItem value="delete">
                  <FontAwesomeIcon icon={faTrash} className="mr-2" />
                  Delete Users
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Choose what action to perform on the selected users
            </p>
          </div>
        </div>
      </div>

      {action && (
        <div className="space-y-4">
          <h4 className="flex items-center gap-2 text-lg font-medium">
            <FontAwesomeIcon icon={faSliders} className="text-sm text-primary" />
            Configure Action
          </h4>
          <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
            {renderActionContent()}
          </div>
        </div>
      )}
    </div>
  );

  const isLinkActionInvalid =
    action === 'manage_local_link' &&
    localLinkMode === 'link' &&
    (multipleLocalUsersSelected || !targetLocalUserUuid || selectedServiceUserUuids.size === 0);

  const footer = [
    <Button key="cancel" onClick={onClose} variant="outline" disabled={submitting}>
      Cancel
    </Button>,
    <Button
      key="submit"
      onClick={handleSubmit}
      disabled={!action || submitting || isLinkActionInvalid}
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
          {action === 'manage_expiration'
            ? expirationMode === 'set'
              ? 'Set Expiration'
              : expirationMode === 'extend'
                ? 'Extend Access'
              : 'Clear Expiration'
            : action === 'manage_local_link'
              ? localLinkMode === 'link'
                ? 'Link Users'
                : 'Unlink Users'
            : 'Apply Changes'}
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
