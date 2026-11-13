"use client"

import * as React from "react"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import {
  faChartLine,
  faUsers,
  faTicket,
  faLayerGroup,
  faTowerBroadcast,
  faDesktop,
  faRotate,
  faCheck,
} from "@fortawesome/free-solid-svg-icons"
import { useLocation } from "@tanstack/react-router"

import { NavMain } from "@/components/layout/NavMain"
import { NavServers } from "@/components/layout/NavServers"
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
import { syncAllUsers, userSyncNotices } from "@/lib/userSync"
import { useSyncStatus } from "@/hooks/useSyncStatus"
import { USER_TOTAL_KEY_PREFIX, useUserTotal } from "@/hooks/useUserTotal"
import { SidebarCount } from "@/components/layout/SidebarCount"
import { useSWRConfig } from "swr"
import { useUserPreferences } from "@/hooks/useUserPreferences"
import { useStreamingSummary } from "@/hooks/useStreamingSummary"
import { Badge } from "@/components/ui/badge"

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { isAdministrator, isOwner, hasAdminAccess, user: currentUser } = useAuth()
  const { isMobile, setOpenMobile } = useSidebar()
  const { success, error } = useAlerts()
  const { syncStatus } = useSyncStatus()
  const { getPreference, dbPreferences, syncEnabled } = useUserPreferences()
  const [streamBadgeEnabled, setStreamBadgeEnabled] = React.useState(() =>
    getPreference('stream_counter', false)
  )
  // A badge is a complete fresh supported-source observation count, not live playback.
  const { summary: observationSummary } = useStreamingSummary('all', streamBadgeEnabled && isAdministrator)
  const observedCount = observationSummary?.servers.length && observationSummary.servers.every(s => s.freshness === 'fresh') ? observationSummary.fresh_current_observations : null
  const [isStartingSync, setIsStartingSync] = React.useState(false)
  const [showSyncComplete, setShowSyncComplete] = React.useState(false)
  const userTotal = useUserTotal({ enabled: isAdministrator })
  // A finished user sync refreshes every sidebar user count.
  const { mutate } = useSWRConfig()
  const refreshUserTotals = React.useCallback(() => {
    void mutate((key) => typeof key === "string" && key.startsWith(USER_TOTAL_KEY_PREFIX))
  }, [mutate])
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
      // The request returns once the sync has finished, with its results.
      const { results, summary } = await syncAllUsers()
      for (const notice of userSyncNotices(results, summary)) {
        (notice.ok ? success : error)(notice.text)
      }
      refreshUserTotals()
    } catch (err: any) {
      if (err.status === 409) {
        error(err.message || 'A sync is already in progress')
      } else {
        error('Failed to sync users')
      }
    } finally {
      setIsStartingSync(false)
    }
  }

  React.useEffect(() => {
    if (syncStatus.is_syncing) {
      setIsStartingSync(false)
    }
  }, [syncStatus.is_syncing])

  React.useEffect(() => {
    setStreamBadgeEnabled(getPreference('stream_counter', false))
  }, [getPreference, dbPreferences, syncEnabled])


  React.useEffect(() => {
    const wasSyncing = previousSyncingRef.current
    const isSyncingNow = syncStatus.is_syncing

    previousSyncingRef.current = isSyncingNow

    if (!isSyncingNow && wasSyncing) {
      refreshUserTotals()
      setShowSyncComplete(true)
      const timeout = window.setTimeout(() => setShowSyncComplete(false), 3000)
      return () => window.clearTimeout(timeout)
    }

    if (isSyncingNow) {
      setShowSyncComplete(false)
    }
  }, [syncStatus.is_syncing, refreshUserTotals])

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
          <FontAwesomeIcon icon={faRotate} className="size-4 text-primary animate-spin" />
        ) : showSyncComplete ? (
          <FontAwesomeIcon icon={faCheck} className="size-4 text-emerald-500" />
        ) : null
      )
    : null

  // Stream badge indicator - show when enabled and there are active streams
  const streamBadgeIndicator = streamBadgeEnabled && observedCount !== null && BigInt(observedCount) > 0n
    ? (
        <Badge variant="default" className="h-5 min-w-5 px-1.5 text-[10px] font-semibold" title="Fresh Jellyfin/Emby observations; not a live playback total">
          {observedCount}
        </Badge>
      )
    : null

  // Helper function to check if a nav item is active
  const isNavItemActive = (url: string) => {
    // Exact match for most pages
    if (location.pathname === url) return true

    // For Users page, also match user detail pages
    if (url === '/admin/users' && location.pathname.startsWith('/admin/users/')) return true

    // For Servers page, also match server pages, including their library and media pages
    if (url === '/admin/servers' && location.pathname.startsWith('/admin/servers/')) return true

    return false
  }

  // Settings has its own sidebar; every other page, server pages included,
  // shows the full navigation (the server being viewed opens in the list).
  const isSettingsRoute = location.pathname.startsWith('/admin/settings')
  const isFocusedRoute = isSettingsRoute

  // All nav items are visible to administrators (owner or users with admin roles)
  const navMainItems = isAdministrator
    ? (
        isFocusedRoute
          ? [
              {
                title: 'Dashboard',
                url: '/admin/dashboard',
                icon: faChartLine,
                isActive: isNavItemActive('/admin/dashboard'),
              },
            ]
          : [
              {
                title: 'Dashboard',
                url: '/admin/dashboard',
                icon: faChartLine,
                isActive: isNavItemActive('/admin/dashboard'),
              },
              {
                title: 'Graphs',
                url: '/admin/graphs',
                icon: faChartLine,
                isActive: isNavItemActive('/admin/graphs'),
              },
              {
                title: 'Users',
                url: '/admin/users',
                icon: faUsers,
                isActive: isNavItemActive('/admin/users'),
                actions: [
                  {
                    label: 'Sync Users',
                    icon: faRotate,
                    iconClassName: syncInProgress ? 'animate-spin text-primary' : undefined,
                    onClick: handleSyncUsers,
                    disabled: syncInProgress,
                  }
                ],
                count: userTotal !== null ? <SidebarCount value={userTotal} singular="user" plural="users" /> : null,
                statusIndicator: syncStatusIndicator,
              },
              {
                title: 'Invites',
                url: '/admin/invites',
                icon: faTicket,
                isActive: isNavItemActive('/admin/invites'),
              },
              {
                title: 'Servers',
                url: '/admin/servers',
                icon: faLayerGroup,
                isActive: isNavItemActive('/admin/servers'),
              },
              {
                title: 'Streaming',
                url: '/admin/streaming',
                icon: faTowerBroadcast,
                isActive: isNavItemActive('/admin/streaming'),
                statusIndicator: streamBadgeIndicator,
              },
            ]
      )
    : []

  const user = {
    name: currentUser?.display_name || currentUser?.username || 'User',
    email: currentUser?.email || 'No email',
    avatar: '', // Avatar not available in User type - will use fallback
  }

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg">
              <a href="/admin/dashboard" onClick={handleLogoClick}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <FontAwesomeIcon icon={faDesktop} className="size-4" />
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
        {!isFocusedRoute ? <NavServers /> : null}
        {isSettingsRoute ? <NavSettings /> : null}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  )
}
