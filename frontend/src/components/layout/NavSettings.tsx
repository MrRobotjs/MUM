"use client"

import * as React from "react"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core"
import {
  faGear,
  faSliders,
  faUsers,
  faUserCircle,
  faShield,
  faShieldHalved,
  faPuzzlePiece,
  faClock,
  faCode,
  faGauge,
  faChevronRight,
  faBook,
} from "@fortawesome/free-solid-svg-icons"
import { faDiscord } from "@fortawesome/free-brands-svg-icons"
import { Link, useLocation } from "@tanstack/react-router"

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
  icon: IconDefinition
  permission?: string
}

type NavSection = {
  title: string
  icon: IconDefinition
  permission?: string
  items: NavItem[]
}

export function NavSettings() {
  const { hasPermission, hasAnyPermission, isOwner } = useAuth()
  const { isMobile, setOpenMobile } = useSidebar()
  const location = useLocation()

  const handleNavLinkClick = () => {
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  // Helper function to check if a nav item is active
  const isNavItemActive = (url: string) => {
    // Exact match
    if (location.pathname === url) return true

    // For settings pages with sub-routes (e.g., /admin/settings/plugins/[pluginId])
    if (location.pathname.startsWith(url + '/')) return true

    return false
  }

  type SettingsItem = NavItem | NavSection

  const settingsItems: SettingsItem[] = [
    {
      title: 'General',
      url: '/admin/settings/general',
      icon: faSliders,
      permission: 'manage_general_settings',
    },
    {
      title: 'Users',
      icon: faUsers,
      permission: 'view_users',
      items: [
        {
          title: 'General',
          url: '/admin/settings/users/general',
          icon: faGear,
          permission: 'manage_users_general',
        },
        {
          title: 'Roles',
          url: '/admin/settings/user-roles',
          icon: faUserCircle,
          permission: 'manage_user_roles',
        },
      ],
    },
    {
      title: 'Manage Admins',
      icon: faShield,
      permission: 'view_admins_tab',
      items: [
        {
          title: 'Admins',
          url: '/admin/settings/admins',
          icon: faShieldHalved,
          permission: 'manage_admins',
        },
        {
          title: 'Roles',
          url: '/admin/settings/admin-roles',
          icon: faShield,
          permission: 'manage_roles',
        },
      ],
    },
    {
      title: 'Plugins',
      url: '/admin/settings/plugins',
      icon: faPuzzlePiece,
      permission: 'manage_plugins',
    },
    {
      title: 'Discord',
      url: '/admin/settings/discord',
      icon: faDiscord,
      permission: 'manage_discord_settings',
    },
    {
      title: 'Logs',
      url: '/admin/settings/logs',
      icon: faClock,
      permission: 'view_logs',
    },
    {
      title: 'Advanced',
      url: '/admin/settings/advanced',
      icon: faGauge,
      permission: 'manage_advanced_settings',
    },
    {
      title: 'API Debug',
      url: '/admin/settings/api-debug',
      icon: faCode,
      permission: 'manage_advanced_settings',
    },
    {
      title: 'API Docs',
      url: '/admin/api-docs',
      icon: faBook,
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

            // Check if any sub-item is active to keep the section open
            const isAnySubItemActive = visibleItems.some((subItem) => isNavItemActive(subItem.url))

            return (
              <Collapsible key={item.title} asChild defaultOpen={isAnySubItemActive}>
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton tooltip={item.title}>
                      <FontAwesomeIcon icon={item.icon} className="h-4 w-4" />
                      <span>{item.title}</span>
                      <FontAwesomeIcon
                        icon={faChevronRight}
                        className="ml-auto h-4 w-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90"
                      />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {visibleItems.map((subItem) => (
                        <SidebarMenuSubItem key={subItem.title}>
                          <SidebarMenuSubButton asChild isActive={isNavItemActive(subItem.url)}>
                            <Link to={subItem.url} onClick={handleNavLinkClick}>
                              <FontAwesomeIcon icon={subItem.icon} className="h-4 w-4" />
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
                      <FontAwesomeIcon icon={item.icon} className="h-4 w-4" />
                      <span>{item.title}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )
            }

            return (
              <SidebarMenuItem key={item.title}>
              <SidebarMenuButton asChild tooltip={item.title} isActive={isNavItemActive(item.url)}>
                <Link to={item.url} onClick={handleNavLinkClick}>
                    <FontAwesomeIcon icon={item.icon} className="h-4 w-4" />
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
