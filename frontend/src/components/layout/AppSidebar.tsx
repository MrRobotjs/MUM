"use client"

import * as React from "react"
import {
  IconChartLine,
  IconUsers,
  IconTicket,
  IconStack2,
  IconBroadcast as IconRadio,
  IconDeviceDesktop,
  IconRefresh,
  IconCheck,
} from "@tabler/icons-react"
import { useLocation } from "@tanstack/react-router"

import { NavMain } from "@/components/layout/NavMain"
import { NavSettings } from "@/components/layout/NavSettings"
import { NavUser } from "@/components/layout/NavUser"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useAuth } from "@/contexts/AuthContext"
import { useAlerts } from "@/contexts/AlertContext"
import { requestJson } from "@/util/apiClient"
import { PREFERENCE_EVENT, type PreferenceChangeDetail } from "@/util/preferences"
import { useSyncStatus } from "@/hooks/useSyncStatus"
import { useUserPreferences } from "@/hooks/useUserPreferences"
import { useStreamingWebSocket } from "@/hooks/useStreamingWebSocket"
import { Badge } from "@/components/ui/badge"

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { isAdministrator, isOwner, hasAdminAccess, user: currentUser } = useAuth()
  const { isMobile, setOpenMobile } = useSidebar()
  const { success, error } = useAlerts()
  const { syncStatus } = useSyncStatus()
  const { getPreference, dbPreferences, syncEnabled } = useUserPreferences()
  const [streamBadgeEnabled, setStreamBadgeEnabled] = React.useState(() =>
    getPreference<boolean>('stream_counter', false)
  )
  // Streaming socket connection is managed globally; this hook only reads the shared state.
  const { activeCount } = useStreamingWebSocket({ autoConnect: false })
  const [isStartingSync, setIsStartingSync] = React.useState(false)
  const [showSyncComplete, setShowSyncComplete] = React.useState(false)
  const previousSyncingRef = React.useRef(syncStatus.is_syncing)
  const location = useLocation()

  const handleLogoClick = () => {
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  const handleSyncUsers = async () => {
    if (isStartingSync || syncStatus.is_syncing) return

    setIsStartingSync(true)
    try {
      await requestJson('/admin/api/v2/users/sync-all', {
        method: 'POST',
      })

      success('User sync started successfully')
    } catch (err: any) {
      if (err.status === 409) {
        error(err.message || 'A sync is already in progress')
      } else {
        error('Failed to start user sync')
      }
      setIsStartingSync(false)
    }
  }

  React.useEffect(() => {
    if (syncStatus.is_syncing) {
      setIsStartingSync(false)
    }
  }, [syncStatus.is_syncing])

  React.useEffect(() => {
    setStreamBadgeEnabled(getPreference<boolean>('stream_counter', false))
  }, [getPreference, dbPreferences, syncEnabled])

  React.useEffect(() => {
    const handlePreferenceChange = (event: Event) => {
      const customEvent = event as CustomEvent<PreferenceChangeDetail>
      if (customEvent.detail?.key !== 'stream_counter') return
      setStreamBadgeEnabled(Boolean(customEvent.detail.value))
    }

    window.addEventListener(PREFERENCE_EVENT, handlePreferenceChange)
    return () => {
      window.removeEventListener(PREFERENCE_EVENT, handlePreferenceChange)
    }
  }, [])

  React.useEffect(() => {
    const wasSyncing = previousSyncingRef.current
    const isSyncingNow = syncStatus.is_syncing

    previousSyncingRef.current = isSyncingNow

    if (!isSyncingNow && wasSyncing) {
      setShowSyncComplete(true)
      const timeout = window.setTimeout(() => setShowSyncComplete(false), 3000)
      return () => window.clearTimeout(timeout)
    }

    if (isSyncingNow) {
      setShowSyncComplete(false)
    }
  }, [syncStatus.is_syncing])

  React.useEffect(() => {
    if (!isStartingSync) {
      return
    }

    const timeout = window.setTimeout(() => {
      setIsStartingSync(false)
    }, 6000)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [isStartingSync])

  const syncInProgress = syncStatus.is_syncing || isStartingSync

  // Only show sync indicator if user has admin access (can edit users)
  const syncStatusIndicator = isAdministrator
    ? (
        syncInProgress ? (
          <IconRefresh className="size-4 text-primary animate-spin" />
        ) : showSyncComplete ? (
          <IconCheck className="size-4 text-emerald-500" />
        ) : null
      )
    : null

  // Stream badge indicator - show when enabled and there are active streams
  const streamBadgeIndicator = streamBadgeEnabled && activeCount > 0
    ? (
        <Badge variant="default" className="h-5 min-w-5 px-1.5 text-[10px] font-semibold">
          {activeCount}
        </Badge>
      )
    : null

  // Helper function to check if a nav item is active
  const isNavItemActive = (url: string) => {
    // Exact match for most pages
    if (location.pathname === url) return true

    // For Users page, also match user detail pages
    if (url === '/admin/users' && location.pathname.startsWith('/admin/users/')) return true

    // For Libraries page, also match library and media detail pages
    if (url === '/admin/libraries' && location.pathname.startsWith('/admin/libraries/')) return true

    return false
  }

  // All nav items are visible to administrators (owner or users with admin roles)
  const navMainItems = isAdministrator ? [
    {
      title: 'Dashboard',
      url: '/admin/dashboard',
      icon: IconChartLine,
      isActive: isNavItemActive('/admin/dashboard'),
    },
    {
      title: 'Users',
      url: '/admin/users',
      icon: IconUsers,
      isActive: isNavItemActive('/admin/users'),
      actions: [
        {
          label: 'Sync Users',
          icon: IconRefresh,
          iconClassName: syncInProgress ? 'animate-spin text-primary' : undefined,
          onClick: handleSyncUsers,
          disabled: syncInProgress,
        }
      ],
      statusIndicator: syncStatusIndicator,
    },
    {
      title: 'Invites',
      url: '/admin/invites',
      icon: IconTicket,
      isActive: isNavItemActive('/admin/invites'),
    },
    {
      title: 'Libraries',
      url: '/admin/libraries',
      icon: IconStack2,
      isActive: isNavItemActive('/admin/libraries'),
    },
    {
      title: 'Streaming',
      url: '/admin/streaming',
      icon: IconRadio,
      isActive: isNavItemActive('/admin/streaming'),
      statusIndicator: streamBadgeIndicator,
    },
  ] : []

  const user = {
    name: currentUser?.display_name || currentUser?.username || 'User',
    email: currentUser?.email || 'No email',
    avatar: '', // Avatar not available in User type - will use fallback
  }

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              size="lg"
              className="data-[slot=sidebar-menu-button]:!p-2"
            >
              <a href="/admin/dashboard" onClick={handleLogoClick}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <IconDeviceDesktop className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Admin Dashboard</span>
                  <span className="truncate text-xs">Media User Manager</span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMainItems} />
        <NavSettings />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  )
}
