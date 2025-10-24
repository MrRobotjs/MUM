"use client"

import * as React from "react"
import {
  IconChartLine,
  IconUsers,
  IconTicket,
  IconStack2,
  IconBroadcast as IconRadio,
  IconDeviceDesktop,
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

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { hasPermission, user: currentUser } = useAuth()
  const { isMobile, setOpenMobile } = useSidebar()

  const handleLogoClick = () => {
    if (isMobile) {
      setOpenMobile(false)
    }
  }

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
      permission: 'view_users'
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
                  <span className="truncate font-semibold">MUM Admin</span>
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
