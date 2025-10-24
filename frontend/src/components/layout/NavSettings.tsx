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
} from "@tabler/icons-react"
import { NavLink } from "react-router-dom"

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

  const settingsSections: NavSection[] = [
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
  ]

  const additionalSettingsItems: NavItem[] = [
    {
      title: 'General',
      url: '/admin/settings/general',
      icon: IconAdjustments,
      permission: 'manage_general_settings',
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
      title: 'Advanced',
      url: '/admin/settings/advanced',
      icon: IconGauge,
      permission: 'manage_advanced_settings',
    },
    {
      title: 'Logs',
      url: '/admin/settings/logs',
      icon: IconTimeline,
      permission: 'view_logs',
    },
    {
      title: 'API Debug',
      url: '/admin/settings/api-debug',
      icon: IconCode,
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

  if (!canAccessSettings) {
    return null
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Settings</SidebarGroupLabel>
      <SidebarMenu>
        {settingsSections.filter(filterSectionByPermission).map((section) => {
          const visibleItems = section.items.filter(filterByPermission)
          if (visibleItems.length === 0) return null

          return (
            <Collapsible key={section.title} asChild defaultOpen={false}>
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton tooltip={section.title}>
                    <section.icon />
                    <span>{section.title}</span>
                    <IconChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {visibleItems.map((item) => (
                      <SidebarMenuSubItem key={item.title}>
                        <SidebarMenuSubButton asChild>
                          <NavLink to={item.url} onClick={handleNavLinkClick}>
                            <item.icon />
                            <span>{item.title}</span>
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          )
        })}

        {/* Additional flat settings items */}
        {additionalSettingsItems.filter(filterByPermission).map((item) => (
          <SidebarMenuItem key={item.title}>
            <SidebarMenuButton asChild tooltip={item.title}>
              <NavLink to={item.url} onClick={handleNavLinkClick}>
                <item.icon />
                <span>{item.title}</span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
