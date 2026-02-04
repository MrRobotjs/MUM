"use client"

import * as React from "react"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import {
  faChevronRight,
  faLayerGroup,
  faServer,
} from "@fortawesome/free-solid-svg-icons"
import { Link, useLocation } from "@tanstack/react-router"

import { useServerOptions } from "@/hooks/useServerOptions"
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

const formatServiceType = (value: string) => {
  if (!value) return "Servers"
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
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

  const grouped = servers.reduce<Record<string, ServerGroup>>((acc, server) => {
    const serviceType = server.service_type || "servers"
    if (!acc[serviceType]) {
      acc[serviceType] = {
        serviceType,
        servers: [],
      }
    }
    acc[serviceType].servers.push(server)
    return acc
  }, {})

  const groups = Object.values(grouped).sort((a, b) =>
    a.serviceType.localeCompare(b.serviceType)
  )

  const isServerLibrariesActive = (serverId: number) =>
    location.pathname.startsWith(`/admin/libraries/${serverId}`)

  return (
    <>
      {groups.map((group) => (
        <SidebarGroup key={group.serviceType}>
          <SidebarGroupLabel>
            {formatServiceType(group.serviceType)}
          </SidebarGroupLabel>
          <SidebarMenu>
            {group.servers.map((server) => {
              const isActive = isServerLibrariesActive(server.id)
              const libraryUrl = `/admin/libraries/${server.id}?tab=overview`
              return (
                <Collapsible key={server.id} asChild defaultOpen={isActive}>
                  <SidebarMenuItem>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuButton tooltip={server.server_nickname}>
                        <FontAwesomeIcon icon={faServer} className="h-4 w-4" />
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
