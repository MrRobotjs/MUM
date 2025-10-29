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
import { useSyncStatus } from "@/hooks/useSyncStatus"

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { hasPermission, user: currentUser } = useAuth()
  const { isMobile, setOpenMobile } = useSidebar()
  const { success, error } = useAlerts()
  const { syncStatus } = useSyncStatus()
  const [isStartingSync, setIsStartingSync] = React.useState(false)
  const [showSyncComplete, setShowSyncComplete] = React.useState(false)
  const previousSyncingRef = React.useRef(syncStatus.is_syncing)

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

  const syncStatusIndicator = hasPermission('edit_user')
    ? (
        syncInProgress ? (
          <IconRefresh className="size-4 text-primary animate-spin" />
        ) : showSyncComplete ? (
          <IconCheck className="size-4 text-emerald-500" />
        ) : null
      )
    : null

  const navMainItems = [
    {
      title: 'Dashboard',
      url: '/admin/dashboard',
      icon: IconChartLine
    },
    {
      title: 'Users',
      url: '/admin/users',
      icon: IconUsers,
      permission: 'view_users',
      actions: hasPermission('edit_user') ? [
        {
          label: 'Sync Users',
          icon: IconRefresh,
          iconClassName: syncInProgress ? 'animate-spin text-primary' : undefined,
          onClick: handleSyncUsers,
          disabled: syncInProgress,
        }
      ] : undefined,
      statusIndicator: syncStatusIndicator,
    },
    {
      title: 'Invites',
      url: '/admin/invites',
      icon: IconTicket,
      permission: 'view_invites'
    },
    {
      title: 'Libraries',
      url: '/admin/libraries',
      icon: IconStack2,
      permission: 'view_servers'
    },
    {
      title: 'Streaming',
      url: '/admin/streaming',
      icon: IconRadio,
      permission: 'view_streaming'
    },
  ].filter(item => !item.permission || hasPermission(item.permission))

  const user = {
    name: currentUser?.display_name || currentUser?.username || 'User',
    email: currentUser?.email || currentUser?.username || 'user@example.com',
    avatar: currentUser?.avatar || '',
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
