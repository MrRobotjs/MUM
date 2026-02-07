"use client"

import * as React from "react"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { faChevronRight, faGear, faLayerGroup, faServer } from "@fortawesome/free-solid-svg-icons"
import { Link, useLocation } from "@tanstack/react-router"

import { useServerOptions } from "@/hooks/useServerOptions"
import { getServiceIcon } from "@/config/pluginMetadata"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar"

type ServerGroup = {
  serviceType: string
  servers: Array<{
    id: number
    server_nickname: string
    service_type: string
  }>
}

export function NavServers() {
  const { servers } = useServerOptions()
  const { isMobile, setOpenMobile } = useSidebar()
  const location = useLocation()

  const handleNavLinkClick = () => {
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  if (!servers.length) {
    return null
  }

  const groups: ServerGroup[] = [
    {
      serviceType: "servers",
      servers: [...servers].sort((a, b) =>
        (a.server_nickname || "").localeCompare(b.server_nickname || "")
      ),
    },
  ]

  const isServerLibrariesActive = (serverId: number) =>
    location.pathname.startsWith(`/admin/libraries/${serverId}`)

  return (
    <>
      {groups.map((group) => (
        <SidebarGroup key={group.serviceType}>
          <SidebarGroupLabel>Media Servers</SidebarGroupLabel>
          <SidebarMenu>
            {group.servers.map((server) => {
              const isActive = isServerLibrariesActive(server.id)
              const libraryUrl = `/admin/libraries/${server.id}?tab=overview`
              const pluginId = server.service_type
              const serviceIcon =
                getServiceIcon(server.service_type, "h-4 w-4") ?? (
                  <FontAwesomeIcon icon={faServer} className="h-4 w-4" />
                )
              return (
                <Collapsible key={server.id} asChild defaultOpen={isActive}>
                  <SidebarMenuItem>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuButton tooltip={server.server_nickname} className="pr-12">
                        {serviceIcon}
                        <span>{server.server_nickname}</span>
                      </SidebarMenuButton>
                    </CollapsibleTrigger>
                    <SidebarMenuAction
                      asChild
                      showOnHover
                      className="right-8 group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-100"
                      title="Edit server settings"
                      aria-label={`Edit ${server.server_nickname} settings`}
                    >
                      <Link
                        to="/admin/settings/plugins/$pluginId/servers/$serverId"
                        params={{ pluginId, serverId: String(server.id) }}
                        onClick={handleNavLinkClick}
                      >
                        <FontAwesomeIcon icon={faGear} className="h-3.5 w-3.5" />
                      </Link>
                    </SidebarMenuAction>
                    <SidebarMenuAction asChild className="right-2 pointer-events-none">
                      <span aria-hidden="true">
                        <FontAwesomeIcon
                          icon={faChevronRight}
                          className="h-4 w-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90 group-data-[state=open]/menu-item:rotate-90"
                        />
                      </span>
                    </SidebarMenuAction>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton asChild isActive={isActive}>
                            <Link to={libraryUrl} onClick={handleNavLinkClick}>
                              <FontAwesomeIcon icon={faLayerGroup} className="h-4 w-4" />
                              <span>Libraries</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              )
            })}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </>
  )
}
