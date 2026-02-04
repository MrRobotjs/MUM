"use client"

import * as React from "react"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { faChevronRight, faLayerGroup, faServer } from "@fortawesome/free-solid-svg-icons"
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
              const serviceIcon =
                getServiceIcon(server.service_type, "h-4 w-4") ?? (
                  <FontAwesomeIcon icon={faServer} className="h-4 w-4" />
                )
              return (
                <Collapsible key={server.id} asChild defaultOpen={isActive}>
                  <SidebarMenuItem>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuButton tooltip={server.server_nickname}>
                        {serviceIcon}
                        <span>{server.server_nickname}</span>
                        <FontAwesomeIcon
                          icon={faChevronRight}
                          className="ml-auto h-4 w-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90"
                        />
                      </SidebarMenuButton>
                    </CollapsibleTrigger>
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
