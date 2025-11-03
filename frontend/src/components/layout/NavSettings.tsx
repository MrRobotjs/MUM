"use client"

import * as React from "react"
import {
  IconSettings,
  IconAdjustments,
  IconUsers,
  IconSettings as IconCog,
  IconUserCircle as IconUserTag,
  IconShield,
  IconShieldHalf,
  IconPuzzle,
  IconBrandDiscord,
  IconClock as IconTimeline,
  IconCode,
  IconGauge,
  IconChevronRight,
  IconBook,
} from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useAuth } from "@/contexts/AuthContext"

type NavItem = {
  title: string
  url: string
  icon: any
  permission?: string
}

type NavSection = {
  title: string
  icon: any
  permission?: string
  items: NavItem[]
}

export function NavSettings() {
  const { hasPermission, hasAnyPermission, isOwner } = useAuth()
  const { isMobile, setOpenMobile } = useSidebar()

  const handleNavLinkClick = () => {
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  type SettingsItem = NavItem | NavSection

  const settingsItems: SettingsItem[] = [
    {
      title: 'General',
      url: '/admin/settings/general',
      icon: IconAdjustments,
      permission: 'manage_general_settings',
    },
    {
      title: 'Users',
      icon: IconUsers,
      permission: 'view_users',
      items: [
        {
          title: 'General',
          url: '/admin/settings/users/general',
          icon: IconCog,
          permission: 'manage_users_general',
        },
        {
          title: 'Roles',
          url: '/admin/settings/user-roles',
          icon: IconUserTag,
          permission: 'manage_user_roles',
        },
      ],
    },
    {
      title: 'Manage Admins',
      icon: IconShield,
      permission: 'view_admins_tab',
      items: [
        {
          title: 'Admins',
          url: '/admin/settings/admins',
          icon: IconShieldHalf,
          permission: 'manage_admins',
        },
        {
          title: 'Roles',
          url: '/admin/settings/admin-roles',
          icon: IconShield,
          permission: 'manage_roles',
        },
      ],
    },
    {
      title: 'Plugins',
      url: '/admin/settings/plugins',
      icon: IconPuzzle,
      permission: 'manage_plugins',
    },
    {
      title: 'Discord',
      url: '/admin/settings/discord',
      icon: IconBrandDiscord,
      permission: 'manage_discord_settings',
    },
    {
      title: 'Logs',
      url: '/admin/settings/logs',
      icon: IconTimeline,
      permission: 'view_logs',
    },
    {
      title: 'Advanced',
      url: '/admin/settings/advanced',
      icon: IconGauge,
      permission: 'manage_advanced_settings',
    },
    {
      title: 'API Debug',
      url: '/admin/settings/api-debug',
      icon: IconCode,
      permission: 'manage_advanced_settings',
    },
    {
      title: 'API Docs',
      url: '/admin/api-docs',
      icon: IconBook,
      permission: 'manage_advanced_settings',
    },
  ]

  const canAccessSettings =
    isOwner ||
    hasAnyPermission(
      'manage_general_settings',
      'manage_discord_settings',
      'manage_advanced_settings',
      'view_admins_tab'
    )

  const filterByPermission = (item: NavItem) => {
    if (!item.permission) return true
    return isOwner || hasPermission(item.permission)
  }

  const filterSectionByPermission = (section: NavSection) => {
    if (!section.permission && section.items.every((item) => !item.permission)) return true
    if (isOwner) return true
    if (section.permission && !hasPermission(section.permission)) return false
    return section.items.some(filterByPermission)
  }

  const isNavSection = (item: SettingsItem): item is NavSection => {
    return 'items' in item
  }

  if (!canAccessSettings) {
    return null
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Settings</SidebarGroupLabel>
      <SidebarMenu>
        {settingsItems.map((item) => {
          // Check if it's a section (has items) or a simple nav item
          if (isNavSection(item)) {
            // Collapsible section
            if (!filterSectionByPermission(item)) return null
            const visibleItems = item.items.filter(filterByPermission)
            if (visibleItems.length === 0) return null

            return (
              <Collapsible key={item.title} asChild defaultOpen={false}>
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton tooltip={item.title}>
                      <item.icon />
                      <span>{item.title}</span>
                      <IconChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {visibleItems.map((subItem) => (
                        <SidebarMenuSubItem key={subItem.title}>
                          <SidebarMenuSubButton asChild>
                            <Link to={subItem.url} onClick={handleNavLinkClick}>
                              <subItem.icon />
                              <span>{subItem.title}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            )
          } else {
            // Simple nav item
            if (!filterByPermission(item)) return null

            // Special handling for API Docs - open in new tab
            if (item.title === 'API Docs') {
              return (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild tooltip={item.title}>
                    <a href={item.url} target="_blank" rel="noopener noreferrer">
                      <item.icon />
                      <span>{item.title}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )
            }

            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton asChild tooltip={item.title}>
                  <Link to={item.url} onClick={handleNavLinkClick}>
                    <item.icon />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          }
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}
