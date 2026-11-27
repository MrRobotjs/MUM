import { useState, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
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
import { type Library } from '../../hooks/useLibraries';
import { useProviderFeatures } from '../../hooks/useProviderFeatures';
import { useServerOptions } from '../../hooks/useServerOptions';
import { requestJson } from '../../util/apiClient';
import { EditOperationsClient, runEditOperation, editOutcomeMessage, editLibraryExternalIds, readEditExpiry, editExpiryNote, editExpiryOutcome, type EditExpiryOverview, type EditIntent, type EditReceipt } from '../../lib/editOperations';
import { useAlerts } from '../../contexts/AlertContext';
import { useAuth } from '../../contexts/AuthContext';
import { getAuthSnapshot, subscribeToAuthStore } from '../../store/authStore';
import { useMediaQuery } from '../../store/mediaQueryStore';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { UserAvatar } from './UserAvatar';
import { ServiceIcon } from '../services/ServiceIcon';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Spinner } from '@/components/ui/spinner'
import {
  faBan,
  faCalendar,
  faCalendarPlus,
  faCheck,
  faCircleInfo,
  faFilm,
  faFolder,
  faInfinity,
  faLink,
  faListCheck,
  faShieldHalved,
  faTrash,
  faTriangleExclamation,
  faUnlock,
  faUsersGear,
} from '@fortawesome/free-solid-svg-icons';
import { InfoButton } from '../common/InfoButton';
interface EditUsersModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedUserIds: Set<string>;
  onComplete?: () => void;
  initialAction?: string;
}

interface LibraryChecks {
  [libraryId: string]: boolean;
}

interface LocalLinkUserOption {
  uuid: string;
  displayName: string;
  username?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  userType: 'local' | 'owner';
}

interface ServiceLinkOption {
  uuid: string;
  displayName: string;
  serviceType?: string | null;
  serverName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  linkedLocalName?: string | null;
  selectable: boolean;
  fromSelection: boolean;
}

interface SelectedServiceLibraryUser {
  uuid: string;
  displayName: string;
  serverId: number;
  serverNickname: string;
  serviceType: string;
  supportsLibraryScopedGrants: boolean;
  allowedLibraryIds: string[];
  hasAllLibraries: boolean;
}

interface LibraryServerSelection {
  serverId: number;
  serverNickname: string;
  serviceType: string;
  users: SelectedServiceLibraryUser[];
  libraries: Library[];
  libraryChecks: LibraryChecks;
  grantAllLibraries: boolean;
  error?: string | null;
}

export const EditUsersModal = ({ isOpen, onClose, selectedUserIds, onComplete, initialAction = '' }: EditUsersModalProps) => {
  const [action, setAction] = useState<string>(initialAction);
  const desktop = useMediaQuery('(min-width: 1024px)');
  const { user } = useAuth();
  const actor = user?.uuid ?? '';
  const auth = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot);
  const { success, error } = useAlerts();
  const client = useRef(new EditOperationsClient());
  const busy = useRef(false);
  const selectionKey = [...selectedUserIds].sort().join(',');
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (isOpen) setAction(initialAction);
  }, [isOpen, selectionKey, initialAction]);

  // Modify Libraries state
  const [librarySelectionsByServer, setLibrarySelectionsByServer] = useState<Record<string, LibraryServerSelection>>({});
  const [loadingLibrarySelections, setLoadingLibrarySelections] = useState(false);
  const [librarySelectionsError, setLibrarySelectionsError] = useState<string | null>(null);
  const [unsupportedLibraryServiceUsers, setUnsupportedLibraryServiceUsers] = useState<SelectedServiceLibraryUser[]>([]);

  // Extend Access state
  const [extendDays, setExtendDays] = useState<number>(30);

  // Set Expiration state
  const [expirationDate, setExpirationDate] = useState<Date | undefined>(undefined);
  const [expirationMode, setExpirationMode] = useState<'set' | 'extend' | 'clear'>('set');
  // Which selected users have an expiration date; null until read.
  const [expiryOverview, setExpiryOverview] = useState<EditExpiryOverview | null>(null);
  const [expiryOverviewFailed, setExpiryOverviewFailed] = useState(false);
  const noneDated = expiryOverview !== null && expiryOverview.dated === 0;
  const expiryNote = editExpiryNote(expiryOverview);

  // 4K transcoding state
  const [allow4kTranscode, setAllow4kTranscode] = useState<'allow' | 'block'>('block');

  // Purge protection state
  const [purgeProtection, setPurgeProtection] = useState<'protect' | 'unprotect'>('protect');

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

  useEffect(() => {
    if (!isOpen || action !== 'manage_expiration' || selectedUserIds.size === 0) return;
    let current = true;
    setExpiryOverview(null);
    setExpiryOverviewFailed(false);
    readEditExpiry([...selectedUserIds]).then(
      (overview) => { if (current) setExpiryOverview(overview); },
      () => { if (current) setExpiryOverviewFailed(true); },
    );
    return () => { current = false; };
    // selectionKey stands for selectedUserIds.
  }, [isOpen, action, selectionKey]);

  // Extending or clearing does nothing when no selected user has a date.
  useEffect(() => {
    if (noneDated && expirationMode !== 'set') setExpirationMode('set');
  }, [noneDated, expirationMode]);

  const { servers } = useServerOptions();
  const { data: providerFeatures } = useProviderFeatures();

  useEffect(() => {
    // Reset state when action changes
    if (action === 'modify_libraries') {
      setLibrarySelectionsByServer({});
      setLibrarySelectionsError(null);
      setUnsupportedLibraryServiceUsers([]);
    } else if (action === 'manage_expiration') {
      setExpirationMode('set');
      setExpirationDate(undefined);
      setExtendDays(30);
    } else if (action === 'manage_4k_transcode') {
      setAllow4kTranscode('block');
    } else if (action === 'manage_purge_protection') {
      setPurgeProtection('protect');
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
  }, [action]);

  const libraryScopedSupportByService = useMemo(() => {
    const metadata = providerFeatures ?? {};
    return Object.entries(metadata).reduce<Record<string, boolean>>((acc, [serviceType, value]) => {
      acc[String(serviceType).toLowerCase()] = value.supports_library_scoped_grants === true;
      return acc;
    }, {});
  }, [providerFeatures]);

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
    if (!isOpen || action !== 'modify_libraries') return;
    if (!Object.values(libraryScopedSupportByService).some(Boolean)) {
      setLibrarySelectionsError('Library access editing is unavailable in the current runtime.');
      setLoadingLibrarySelections(false);
      return;
    }

    let cancelled = false;

    const loadLibrarySelections = async () => {
      setLoadingLibrarySelections(true);
      setLibrarySelectionsError(null);
      try {
        type UserDetailResponse = {
          data: {
            uuid: string;
            user_type?: string | null;
            server_id?: number | null;
            server_nickname?: string | null;
            service_type?: string | null;
            allowed_library_ids?: string[] | null;
            has_all_libraries?: boolean | null;
            display_name?: string | null;
            username?: string | null;
            local_username?: string | null;
            external_username?: string | null;
            external_email?: string | null;
            email?: string | null;
          };
        };
        type LibrariesResponse = { data: Library[] };

        const selectedUuids = Array.from(selectedUserIds);
        if (selectedUuids.length === 0) {
          setLibrarySelectionsByServer({});
          setUnsupportedLibraryServiceUsers([]);
          return;
        }

        const serverMap = new Map(
          servers.map((server) => [String(server.id), server])
        );

        const selectedDetails = await Promise.all(
          selectedUuids.map(async (uuid) => {
            try {
              const response = await requestJson<UserDetailResponse>(`/api/users/${uuid}`);
              return response?.data ?? null;
            } catch {
              throw Error(`Could not load selected account ${uuid}. No reduced selection will be submitted.`);
            }
          })
        );

        if (cancelled) return;

        const selectedServiceUsers: SelectedServiceLibraryUser[] = selectedDetails
          .filter((detail): detail is NonNullable<typeof detail> => Boolean(detail))
          .filter((detail) => String(detail.user_type ?? '').toLowerCase() === 'service' && Boolean(detail.server_id))
          .map((detail) => {
            const serverId = Number(detail.server_id);
            const fallbackServer = serverMap.get(String(serverId));
            const resolvedServiceType =
              detail.service_type ??
              fallbackServer?.service_type ??
              'service';
            const metadataCapability = libraryScopedSupportByService[String(resolvedServiceType).toLowerCase()];
            const supportsLibraryScopedGrants = metadataCapability === true;
            return {
              uuid: detail.uuid,
              displayName: getDisplayName(detail),
              serverId,
              serverNickname:
                detail.server_nickname ??
                fallbackServer?.server_nickname ??
                `Server ${serverId}`,
              serviceType: resolvedServiceType,
              supportsLibraryScopedGrants,
              allowedLibraryIds: (detail.allowed_library_ids ?? []).map((id) => String(id)),
              hasAllLibraries: Boolean(detail.has_all_libraries),
            };
          });

        const unsupportedUsers = selectedServiceUsers.filter(
          (serviceUser) => !serviceUser.supportsLibraryScopedGrants
        );
        setUnsupportedLibraryServiceUsers(unsupportedUsers);

        const manageableServiceUsers = selectedServiceUsers.filter(
          (serviceUser) => serviceUser.supportsLibraryScopedGrants
        );

        if (manageableServiceUsers.length === 0) {
          setLibrarySelectionsByServer({});
          return;
        }

        const usersByServer = new Map<string, SelectedServiceLibraryUser[]>();
        manageableServiceUsers.forEach((serviceUser) => {
          const key = String(serviceUser.serverId);
          const existing = usersByServer.get(key);
          if (existing) {
            existing.push(serviceUser);
          } else {
            usersByServer.set(key, [serviceUser]);
          }
        });

        const entries = await Promise.all(
          Array.from(usersByServer.entries()).map(async ([serverId, usersForServer]) => {
            const firstUser = usersForServer[0];
            let librariesForServer: Library[] = [];
            let serverError: string | null = null;

            try {
              const response = await requestJson<LibrariesResponse>(
                `/api/libraries?server_id=${serverId}&include_server=true`
              );
              librariesForServer = response?.data ?? [];
            } catch (err) {
              serverError =
                err instanceof Error ? err.message : 'Failed to load libraries for this server.';
            }

            const allLibraryIds = librariesForServer.map((library) =>
              getLibraryIdentifier(library, firstUser.serviceType)
            );

            const normalizedAllowedSets = usersForServer.map((serviceUser) =>
              serviceUser.hasAllLibraries
                ? new Set(allLibraryIds)
                : new Set(librariesForServer.filter(library => serviceUser.allowedLibraryIds.some(id => id === String(library.external_id))).map(library => String(library.id)))
            );

            let intersection = new Set<string>();
            if (normalizedAllowedSets.length > 0) {
              intersection = new Set(normalizedAllowedSets[0]);
              normalizedAllowedSets.slice(1).forEach((set) => {
                intersection = new Set(Array.from(intersection).filter((id) => set.has(id)));
              });
            }

            const allUsersHaveAllLibraries =
              usersForServer.length > 0 &&
              usersForServer.every((serviceUser) => serviceUser.hasAllLibraries);

            const nextChecks: LibraryChecks = {};
            allLibraryIds.forEach((libraryId) => {
              nextChecks[libraryId] =
                allUsersHaveAllLibraries || intersection.has(libraryId);
            });

            const selection: LibraryServerSelection = {
              serverId: Number(serverId),
              serverNickname: firstUser.serverNickname,
              serviceType: firstUser.serviceType,
              users: usersForServer,
              libraries: librariesForServer,
              libraryChecks: nextChecks,
              grantAllLibraries: allUsersHaveAllLibraries,
              error: serverError,
            };

            return [serverId, selection] as const;
          })
        );

        if (cancelled) return;

        setLibrarySelectionsByServer(Object.fromEntries(entries));
      } catch (err) {
        if (!cancelled) {
          setLibrarySelectionsByServer({});
          setUnsupportedLibraryServiceUsers([]);
          setLibrarySelectionsError(
            err instanceof Error ? err.message : 'Failed to load selected users for library editing.'
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingLibrarySelections(false);
        }
      }
    };

    loadLibrarySelections();

    return () => {
      cancelled = true;
    };
  }, [action, isOpen, selectedUserIds, servers, libraryScopedSupportByService, auth.accessToken]);

  useEffect(() => {
    if (!isOpen || action !== 'manage_local_link' || localLinkMode !== 'link') return;

    let cancelled = false;

    const loadLocalUsers = async () => {
      setLoadingLocalUsers(true);
      setLocalUsersError(null);
      try {
        type UserListResponse = {
          meta: { pagination: { total_pages: number } };
          data: Array<{
            uuid: string;
            display_name?: string | null;
            username?: string | null;
            email?: string | null;
            external_email?: string | null;
            avatar_url?: string | null;
            user_type: string;
          }>;
        };

        const readAll = async (kind: 'local' | 'owner') => {
          const data: UserListResponse['data'] = [];
          for (let page = 1; ; page++) {
            const response = await requestJson<UserListResponse>(`/api/users?user_type=${kind}&page=${page}&page_size=100&sort=username_asc`, {retryAuthentication:false});
            if (cancelled) return {data: []};
            if (!Array.isArray(response.data) || !Number.isSafeInteger(response.meta?.pagination?.total_pages) || response.meta.pagination.total_pages < 0) throw Error('Invalid local account catalogue. Refresh.');
            data.push(...response.data);
            if (page >= response.meta.pagination.total_pages) return {data};
          }
        };
        const [localsResponse, ownersResponse] = await Promise.all([readAll('local'), readAll('owner')]);
        if (cancelled) return;

        const deduped = new Map<string, LocalLinkUserOption>();
        [...(localsResponse.data ?? []), ...(ownersResponse.data ?? [])].forEach((user) => {
          deduped.set(user.uuid, {
            uuid: user.uuid,
            displayName: getDisplayName(user),
            username: user.username ?? null,
            email: user.email ?? user.external_email ?? null,
            avatarUrl: user.avatar_url ?? null,
            userType: user.user_type?.toLowerCase() === 'owner' ? 'owner' : 'local',
          });
        });

        const sorted = Array.from(deduped.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
        setLocalUsers(sorted);
      } catch (err) {
        if (cancelled) return;
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
  }, [isOpen, action, localLinkMode, auth.accessToken]);

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
              const response = await requestJson<{ data: any }>(`/api/users/${uuid}`);
              return response?.data ?? null;
            } catch {
              throw Error(`Could not load selected account ${uuid}. No reduced selection will be submitted.`);
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
              avatarUrl: detail.avatar_url ?? detail.discord_avatar_url ?? null,
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
              avatarUrl: detail.avatar_url ?? null,
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
        if (cancelled) return;
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
  }, [isOpen, action, localLinkMode, selectedUserIds, auth.accessToken]);

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
            avatar_url?: string | null;
          }>;
        };

        // Current Go users list: service accounts without a primary owner.
        const response: AvailableServiceResponse = { data: [] };
        if (cancelled) return;

        const merged = new Map<string, ServiceLinkOption>();
        (response.data ?? []).forEach((service) => {
          merged.set(service.uuid, {
            uuid: service.uuid,
            displayName: service.external_username || service.external_email || 'Service User',
            serviceType: service.service_type ?? null,
            serverName: service.server_name ?? null,
            email: service.external_email ?? null,
            avatarUrl: service.avatar_url ?? null,
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

  const unsupportedLibraryServiceSummary = useMemo(() => {
    if (unsupportedLibraryServiceUsers.length === 0) return '';

    const counts = unsupportedLibraryServiceUsers.reduce<Record<string, number>>((acc, serviceUser) => {
      const rawService = String(serviceUser.serviceType || 'Unknown').trim();
      const normalized = rawService.toLowerCase();
      const label =
        normalized === 'romm'
          ? 'RomM'
          : rawService
            ? rawService.charAt(0).toUpperCase() + rawService.slice(1)
            : 'Unknown';
      acc[label] = (acc[label] ?? 0) + 1;
      return acc;
    }, {});

    return Object.entries(counts)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([service, count]) => `${service} (${count})`)
      .join(', ');
  }, [unsupportedLibraryServiceUsers]);

  const getLibraryIdentifier = (library: Library, _serviceTypeHint?: string): string => {
    return String(library.id);
  };

  const libraryServerSelections = useMemo(
    () =>
      Object.entries(librarySelectionsByServer)
        .map(([serverId, selection]) => ({
          serverId,
          selection,
        }))
        .sort((a, b) =>
          `${a.selection.serverNickname}`.localeCompare(
            `${b.selection.serverNickname}`
          )
        ),
    [librarySelectionsByServer]
  );

  const handleToggleServerLibrary = (serverId: string, libraryId: string) => {
    setLibrarySelectionsByServer((prev) => {
      const selection = prev[serverId];
      if (!selection) return prev;
      return {
        ...prev,
        [serverId]: {
          ...selection,
          libraryChecks: {
            ...selection.libraryChecks,
            [libraryId]: !selection.libraryChecks[libraryId],
          },
        },
      };
    });
  };

  const handleToggleServerGrantAll = (serverId: string, enabled: boolean) => {
    setLibrarySelectionsByServer((prev) => {
      const selection = prev[serverId];
      if (!selection) return prev;
      return {
        ...prev,
        [serverId]: {
          ...selection,
          grantAllLibraries: enabled,
        },
      };
    });
  };

  // Apply Changes works like the Flask dialog: one click, a toast with the
  // outcome, then the dialog closes. Each change is prepared and run on the
  // server, which checks authority again and never repeats a remote change.
  const handleSubmit = async () => {
    if (!action || busy.current) return;
    const ids = [...selectedUserIds];
    const plural = (count: number) => `${count} user${count !== 1 ? 's' : ''}`;
    const requests: { ids: string[]; intent: EditIntent }[] = [];
    let successMessage = '';
    if (action === 'modify_libraries') {
      if (librarySelectionsError || loadingLibrarySelections) { error('Library details are not loaded yet.'); return; }
      for (const group of Object.values(librarySelectionsByServer)) {
        if (group.error) { error(group.error); return; }
        if (!group.users.length) continue;
        let libraryIds: string[] = [];
        try {
          libraryIds = group.grantAllLibraries ? [] : editLibraryExternalIds(group.libraries, group.libraryChecks);
        } catch (err) {
          error(err instanceof Error ? err.message : 'Library details are not loaded yet.');
          return;
        }
        requests.push({ ids: group.users.map(u => u.uuid), intent: { action: 'update_libraries', has_all_libraries: group.grantAllLibraries, library_ids: libraryIds } });
      }
      if (!requests.length) { error('No service users selected for library updates.'); return; }
      const count = new Set(requests.flatMap(r => r.ids)).size;
      const skippedSuffix = unsupportedLibraryServiceUsers.length > 0 ? ` (${plural(unsupportedLibraryServiceUsers.length)} skipped: ${unsupportedLibraryServiceSummary})` : '';
      successMessage = `Updated library access for ${count} service user${count !== 1 ? 's' : ''} across ${requests.length} server${requests.length !== 1 ? 's' : ''}${skippedSuffix}`;
    } else if (action === 'manage_expiration') {
      if (expirationMode === 'extend') {
        if (!Number.isInteger(extendDays) || extendDays < 1 || extendDays > 36500) { error('Enter 1 to 36500 days.'); return; }
        requests.push({ ids, intent: { action: 'extend_access', days: extendDays } });
        successMessage = `Extended access by ${extendDays} days`;
      } else if (expirationMode === 'set') {
        if (!expirationDate) { error('Please select an expiration date'); return; }
        requests.push({ ids, intent: { action: 'set_expiration', expires_at: expirationDate.toISOString().replace(/\.\d{3}Z$/, 'Z') } });
        successMessage = `Set expiration date for ${plural(ids.length)}`;
      } else {
        requests.push({ ids, intent: { action: 'clear_expiration' } });
        successMessage = 'Cleared expiration date';
      }
    } else if (action === 'manage_4k_transcode') {
      const allow = allow4kTranscode === 'allow';
      requests.push({ ids, intent: { action: 'set_4k_transcode', allow_4k_transcode: allow } });
      successMessage = `${allow ? 'Allowed' : 'Blocked'} 4K transcoding for ${plural(ids.length)}`;
    } else if (action === 'manage_purge_protection') {
      const protect = purgeProtection === 'protect';
      requests.push({ ids, intent: { action: 'set_purge_protection', purge_protected: protect } });
      successMessage = `${protect ? 'Protected' : 'Removed purge protection from'} ${plural(ids.length)}`;
    } else if (action === 'manage_local_link') {
      if (linkContextError || localUsersError || serviceOptionsError) { error('Account details could not be loaded. Close and try again.'); return; }
      if (localLinkMode === 'unlink') {
        requests.push({ ids, intent: { action: 'unlink_local' } });
        successMessage = `Unlinked ${plural(ids.length)} from local account`;
      } else {
        if (multipleLocalUsersSelected) { error('Multiple local users are selected. Please select exactly one local user in the main list and try again.'); return; }
        if (!targetLocalUserUuid) { error('Please select a local user'); return; }
        const serviceIds = [...selectedServiceUserUuids];
        if (!serviceIds.length) { error('Please select at least one service user to link'); return; }
        requests.push({ ids: serviceIds, intent: { action: 'link_local', target_local_user_uuid: targetLocalUserUuid } });
        successMessage = `Linked ${plural(serviceIds.length)} to local account`;
      }
    } else if (action === 'delete') {
      if (!confirm(`Are you sure you want to permanently delete ${plural(ids.length)}? This action cannot be undone.`)) return;
      requests.push({ ids, intent: { action: 'delete_users' } });
      successMessage = `Deleted ${plural(ids.length)}`;
    } else {
      error('Unknown action');
      return;
    }

    busy.current = true;
    setSubmitting(true);
    try {
      const receipts: EditReceipt[] = [];
      for (const request of requests) {
        receipts.push(await runEditOperation(client.current, request.ids, request.intent));
      }
      const problem = editOutcomeMessage(receipts);
      if (problem) error(problem);
      else if (action === 'manage_expiration' && expirationMode !== 'set') success(editExpiryOutcome(successMessage, receipts));
      else success(successMessage);
      onComplete?.();
      onClose();
    } catch (err) {
      error(`Failed to ${action.replace(/_/g, ' ')}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      onComplete?.();
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  };

  const renderActionContent = () => {
    switch (action) {
      case 'modify_libraries':
        return (
          <div className="space-y-4">
            {librarySelectionsError && (
              <Alert variant="warning">
                <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
                <AlertTitle>Failed to Load Library Context</AlertTitle>
                <AlertDescription>{librarySelectionsError}</AlertDescription>
              </Alert>
            )}

            {unsupportedLibraryServiceUsers.length > 0 && (
              <Alert variant="warning">
                <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
                <AlertTitle>Some Services Do Not Support Library Management</AlertTitle>
                <AlertDescription>
                  {unsupportedLibraryServiceUsers.length} selected service user{unsupportedLibraryServiceUsers.length !== 1 ? 's' : ''} {unsupportedLibraryServiceUsers.length === 1 ? 'belongs' : 'belong'} to services without per-user library controls and will be skipped.
                  {' '}Unsupported services: {unsupportedLibraryServiceSummary}.
                </AlertDescription>
              </Alert>
            )}

            {loadingLibrarySelections ? (
              <div className="flex items-center justify-center py-6">
                <Spinner className="size-4" />
              </div>
            ) : libraryServerSelections.length === 0 ? (
              <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
                {unsupportedLibraryServiceUsers.length > 0
                  ? 'None of the selected service users are on services that support library management.'
                  : 'Select at least one service user to modify library access.'}
              </div>
            ) : (
              <div className="space-y-4">
                {libraryServerSelections.map(({ serverId, selection }) => (
                  <div key={serverId} className="space-y-3 rounded-lg border border-border p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="flex items-center gap-2 text-sm font-semibold">
                          <ServiceIcon serviceType={selection.serviceType} className="h-4 w-4 shrink-0" />
                          {selection.serverNickname}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            ({selection.serviceType})
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Applies to {selection.users.length} selected service user{selection.users.length !== 1 ? 's' : ''}.
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {selection.users
                            .slice(0, 4)
                            .map((serviceUser) => serviceUser.displayName)
                            .join(', ')}
                          {selection.users.length > 4 ? ` +${selection.users.length - 4} more` : ''}
                        </p>
                      </div>
                    </div>

                    {selection.users.length > 1 && (
                      <p className="text-xs text-muted-foreground">
                        Preselected libraries are the shared intersection across selected users on this server.
                      </p>
                    )}

                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`grant-all-${serverId}`}
                        checked={selection.grantAllLibraries}
                        onCheckedChange={(checked) =>
                          handleToggleServerGrantAll(serverId, checked === true)
                        }
                      />
                      <Label htmlFor={`grant-all-${serverId}`} className="cursor-pointer">
                        <FontAwesomeIcon icon={faUnlock} className="mr-2" />
                        Grant access to all libraries on this server
                      </Label>
                    </div>

                    {selection.error ? (
                      <p className="text-sm text-destructive">{selection.error}</p>
                    ) : !selection.grantAllLibraries ? (
                      <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border p-3">
                        {selection.libraries.length === 0 ? (
                          <p className="py-3 text-center text-sm text-muted-foreground">
                            No libraries found for this server.
                          </p>
                        ) : (
                          selection.libraries.map((library) => {
                            const libraryId = getLibraryIdentifier(
                              library,
                              selection.serviceType
                            );
                            return (
                              <label
                                key={`${serverId}-${libraryId}`}
                                className="flex cursor-pointer items-center gap-3 rounded p-2 hover:bg-muted"
                              >
                                <Checkbox
                                  checked={Boolean(selection.libraryChecks[libraryId])}
                                  onCheckedChange={() =>
                                    handleToggleServerLibrary(serverId, libraryId)
                                  }
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-medium">
                                    {library.name}
                                  </div>
                                  {library.library_type && (
                                    <div className="text-xs text-muted-foreground">
                                      {library.library_type}
                                    </div>
                                  )}
                                </div>
                              </label>
                            );
                          })
                        )}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case 'manage_expiration':
        return (
          <div className="space-y-4">
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
                  <SelectItem value="extend" disabled={noneDated}>
                    <FontAwesomeIcon icon={faCalendarPlus} className="mr-2" />
                    Extend access duration
                  </SelectItem>
                  <SelectItem value="clear" disabled={noneDated}>
                    <FontAwesomeIcon icon={faInfinity} className="mr-2" />
                    Clear expiration date
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                {expirationMode === 'set'
                  ? 'Replaces any existing expiration date of the selected users.'
                  : expirationMode === 'extend'
                    ? 'Adds days to each expiration date; a date that has already passed is extended from today. Users without an expiration date keep unlimited access.'
                    : 'Removes expiration dates, so access is unlimited until a new date is set.'}
                {expirationMode !== 'set' && expiryNote ? ` ${expiryNote}` : ''}
              </p>
              {noneDated && (
                <p className="text-sm text-muted-foreground">
                  {expiryOverview?.total === 1 ? 'The selected user has' : 'None of the selected users have'} an expiration date, so one can only be set.
                </p>
              )}
              {expiryOverviewFailed && (
                <p className="text-sm text-muted-foreground">
                  Expiration dates could not be read. Apply still checks each user.
                </p>
              )}
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
                      autoFocus
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

      case 'manage_4k_transcode':
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <Label htmlFor="transcode-4k-mode">4K Transcoding</Label>
                <InfoButton title="4K transcoding">
                  <p>When 4K transcoding is blocked, MUM stops a stream once if the server transcodes a 4K video for that user, and shows them a message. Direct play of 4K is never stopped.</p>
                  <p>Applies to Plex, Jellyfin and Emby server accounts; other selected users are skipped.</p>
                </InfoButton>
              </div>
              <Select
                value={allow4kTranscode}
                onValueChange={(value: 'allow' | 'block') => setAllow4kTranscode(value)}
              >
                <SelectTrigger id="transcode-4k-mode" className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="block">
                    <FontAwesomeIcon icon={faBan} className="mr-2" />
                    Block 4K transcoding
                  </SelectItem>
                  <SelectItem value="allow">
                    <FontAwesomeIcon icon={faCheck} className="mr-2" />
                    Allow 4K transcoding
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        );

      case 'manage_purge_protection':
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <Label htmlFor="purge-protection-mode">Purge Protection</Label>
                <InfoButton title="Purge protection">
                  <p>Protected users are left out of inactivity purges. Nothing changes on the media server.</p>
                  <p>Applies to server accounts; MUM accounts are skipped.</p>
                </InfoButton>
              </div>
              <Select
                value={purgeProtection}
                onValueChange={(value: 'protect' | 'unprotect') => setPurgeProtection(value)}
              >
                <SelectTrigger id="purge-protection-mode" className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="protect">
                    <FontAwesomeIcon icon={faShieldHalved} className="mr-2" />
                    Protect from purges
                  </SelectItem>
                  <SelectItem value="unprotect">
                    <FontAwesomeIcon icon={faBan} className="mr-2" />
                    Remove protection
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        );

      case 'manage_local_link':
        return (
          <div className="space-y-4">
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
              <p className="text-sm text-muted-foreground">
                {localLinkMode === 'link'
                  ? 'Links every selected service user to one local account.'
                  : 'Removes the selected service users’ local-account links. No users are deleted.'}
              </p>
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
                            <UserAvatar
                              user={{
                                avatar_url: localUser.avatarUrl,
                                display_name: localUser.displayName,
                                username: localUser.username ?? localUser.email ?? undefined,
                                user_type: localUser.userType,
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
                            <UserAvatar
                              user={{
                                avatar_url: serviceUser.avatarUrl,
                                display_name: serviceUser.displayName,
                                username: serviceUser.email ?? serviceUser.uuid,
                                user_type: 'service',
                                service_type: serviceUser.serviceType,
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

  // The dropdown and the desktop sidebar list the same actions; Delete is
  // kept apart at the end.
  const actions = [
    { value: 'modify_libraries', label: 'Library access', icon: faFolder, hint: 'Choose which libraries they can see' },
    { value: 'manage_expiration', label: 'Expiration', icon: faCalendar, hint: 'Set, extend or clear access dates' },
    { value: 'manage_4k_transcode', label: '4K transcoding', icon: faFilm, hint: 'Allow or block 4K transcodes' },
    { value: 'manage_purge_protection', label: 'Purge protection', icon: faShieldHalved, hint: 'Keep them out of inactivity purges' },
    { value: 'manage_local_link', label: 'Local account link', icon: faLink, hint: 'Link or unlink a MUM account' },
    { value: 'delete', label: 'Delete users', icon: faTrash, hint: 'Remove them and their data' },
  ];
  const selectedAction = actions.find(item => item.value === action);

  const actionPanel = selectedAction ? (
    <div className="space-y-4">
      <div>
        <h4 className={`flex items-center gap-2 text-lg font-medium ${action === 'delete' ? 'text-destructive' : ''}`}>
          <FontAwesomeIcon icon={selectedAction.icon} className={`text-sm ${action === 'delete' ? '' : 'text-primary'}`} />
          {selectedAction.label}
        </h4>
        <p className="text-sm text-muted-foreground">{selectedAction.hint}</p>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        {renderActionContent()}
      </div>
    </div>
  ) : null;

  // Desktop: the actions are a sidebar beside the chosen action's settings.
  // Only the settings column scrolls, so the sidebar never moves.
  const sidebarBody = (
    <div className="flex gap-6">
      <nav aria-label="Edit actions" className="w-56 shrink-0 space-y-1 border-r border-border pr-4">
        {actions.map(item => {
          const selected = item.value === action;
          const danger = item.value === 'delete';
          return (
            <div key={item.value}>
              {danger && <div className="my-2 border-t border-border" />}
              <button
                type="button"
                disabled={submitting}
                aria-current={selected ? 'true' : undefined}
                onClick={() => setAction(item.value)}
                className={`flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                  danger
                    ? selected ? 'bg-destructive/10 text-destructive' : 'text-destructive hover:bg-muted/60'
                    : selected ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
              >
                <FontAwesomeIcon icon={item.icon} className="mt-0.5 w-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block">{item.label}</span>
                  <span className="block text-xs font-normal text-muted-foreground">{item.hint}</span>
                </span>
              </button>
            </div>
          );
        })}
      </nav>
      <div className="min-w-0 flex-1 max-h-[70vh] overflow-y-auto pr-2">
        {actionPanel ?? (
          <div className="flex h-full min-h-55 items-center justify-center rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            Choose an action on the left to change the {selectedUserIds.size} selected user{selectedUserIds.size !== 1 ? 's' : ''}.
          </div>
        )}
      </div>
    </div>
  );

  // Tablets and phones keep the dropdown above the action's settings.
  const dropdownBody = (
    <div className="space-y-6 py-4">
      <div className="space-y-2">
        <Label htmlFor="action">
          <FontAwesomeIcon icon={faListCheck} className="text-primary text-sm mr-2" />
          Action to Perform
        </Label>
        <Select value={action} disabled={submitting} onValueChange={setAction}>
          <SelectTrigger id="action" className="h-11">
            <SelectValue placeholder="Choose an action..." />
          </SelectTrigger>
          <SelectContent>
            {actions.map(item => (
              <SelectItem key={item.value} value={item.value}>
                <FontAwesomeIcon icon={item.icon} className="mr-2" />
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {actionPanel}
    </div>
  );

  const isLinkActionInvalid =
    action === 'manage_local_link' &&
    localLinkMode === 'link' &&
    (multipleLocalUsersSelected || !targetLocalUserUuid || selectedServiceUserUuids.size === 0);
  const isLibraryActionInvalid =
    action === 'modify_libraries' &&
    !loadingLibrarySelections &&
    libraryServerSelections.length === 0;

  const footer = [
    <Button key="cancel" onClick={onClose} variant="outline" disabled={submitting}>
      Cancel
    </Button>,
    <Button
      key="submit"
      onClick={handleSubmit}
      disabled={!action || submitting || isLinkActionInvalid || isLibraryActionInvalid}
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
          <span>Edit Users</span>
        </div>
      }
      description={`Apply changes to ${selectedUserIds.size} selected user${selectedUserIds.size !== 1 ? 's' : ''} at once`}
      footer={footer}
      size="lg"
      bodyClassName={desktop ? 'overflow-hidden' : 'pt-2'}
    >
      {desktop ? sidebarBody : dropdownBody}
    </ResponsiveDialog>
  );
};
