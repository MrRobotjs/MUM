"use client"

import * as React from "react"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import {
  faChevronRight,
  faGear,
  faLayerGroup,
  faRotate,
  faServer,
} from "@fortawesome/free-solid-svg-icons"
import { Link, useLocation } from "@tanstack/react-router"

import { useServerOptions } from "@/hooks/useServerOptions"
import { useServerLibraries } from "@/hooks/useServerLibraries"
import { useSyncServerLibraries } from "@/hooks/useSyncServerLibraries"
import { getServiceIcon } from "@/config/pluginMetadata"
import { useAlerts } from "@/contexts/AlertContext"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
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

type ServerNavItemProps = {
  server: {
    id: number
    server_nickname: string
    service_type: string
  }
  pathname: string
  onNavigate: () => void
}

const ServerNavItem = ({ server, pathname, onNavigate }: ServerNavItemProps) => {
  const { success, error } = useAlerts()
  const [librariesRequested, setLibrariesRequested] = React.useState(false)
  const { libraries, loading, error: librariesError, refresh, hasLoaded } =
    useServerLibraries(server.id, { enabled: librariesRequested })
  const { sync, isSyncing } = useSyncServerLibraries(server.id, {
    onSuccess: () => success("Library sync started"),
    onError: (message) => error(message),
  })

  const pluginId = server.service_type
  const serviceIcon =
    getServiceIcon(server.service_type, "h-4 w-4") ?? (
      <FontAwesomeIcon icon={faServer} className="h-4 w-4" />
    )

  const isLibraryActive = (libraryId: number) =>
    pathname.startsWith(`/admin/libraries/${libraryId}`)

  const requestLibraries = React.useCallback(() => {
    setLibrariesRequested(true)
  }, [])

  const handleSyncLibraries = React.useCallback(async () => {
    requestLibraries()
    await sync()
    await refresh()
  }, [refresh, requestLibraries, sync])

  const handleRetry = React.useCallback(async () => {
    requestLibraries()
    await refresh()
  }, [refresh, requestLibraries])

  const libraryCount =
    hasLoaded && !loading && !librariesError ? libraries.length : null
  const libraryErrorMessage =
    librariesError instanceof Error
      ? librariesError.message
      : "Unable to load libraries."
  const libraryMeta = loading ? (
    <span className="text-[10px] text-muted-foreground">Loading...</span>
  ) : libraryCount !== null ? (
    <span className="text-[10px] text-muted-foreground">{libraryCount}</span>
  ) : null

  return (
    <Collapsible
      asChild
      onOpenChange={(open) => {
        if (open) {
          requestLibraries()
        }
      }}
    >
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
            onClick={onNavigate}
          >
            <FontAwesomeIcon icon={faGear} className="text-[11px]" />
          </Link>
        </SidebarMenuAction>
        <SidebarMenuAction asChild className="right-2 pointer-events-none">
          <span aria-hidden="true">
            <FontAwesomeIcon
              icon={faChevronRight}
              className="text-[11px] transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90 group-data-[state=open]/menu-item:rotate-90"
            />
          </span>
        </SidebarMenuAction>
        <CollapsibleContent>
          <SidebarMenuSub>
            <Collapsible
              asChild
              onOpenChange={(open) => {
                if (open) {
                  requestLibraries()
                }
              }}
            >
              <SidebarMenuSubItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuSubButton asChild className="pr-8">
                    <button type="button">
                      <FontAwesomeIcon icon={faLayerGroup} className="h-4 w-4" />
                      <span>Libraries</span>
                      <span className="ml-auto flex items-center gap-2">
                        {libraryMeta}
                        <FontAwesomeIcon
                          icon={faChevronRight}
                          className="text-[10px] text-muted-foreground transition-transform duration-200 group-data-[state=open]/menu-sub-item:rotate-90"
                        />
                      </span>
                    </button>
                  </SidebarMenuSubButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {loading ? (
                    <div className="space-y-2 px-2 py-2">
                      <Skeleton className="h-3 w-3/4" />
                      <Skeleton className="h-3 w-2/3" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  ) : librariesError ? (
                    <div className="space-y-2 px-2 py-2 text-xs text-muted-foreground">
                      <p>{libraryErrorMessage}</p>
                      <SidebarMenuSubButton asChild size="sm">
                        <button type="button" onClick={handleRetry}>
                          Retry
                        </button>
                      </SidebarMenuSubButton>
                    </div>
                  ) : libraries.length === 0 ? (
                    <div className="space-y-2 px-2 py-2 text-xs text-muted-foreground">
                      <p>No libraries synced yet.</p>
                      <SidebarMenuSubButton asChild size="sm">
                        <button
                          type="button"
                          onClick={handleSyncLibraries}
                          disabled={isSyncing}
                        >
                          <FontAwesomeIcon
                            icon={faRotate}
                            className={`h-3 w-3 ${isSyncing ? "animate-spin" : ""}`}
                          />
                          <span>Sync libraries</span>
                        </button>
                      </SidebarMenuSubButton>
                    </div>
                  ) : (
                    <SidebarMenuSub>
                      {libraries.map((library) => (
                        <SidebarMenuSubItem key={library.id}>
                          <SidebarMenuSubButton
                            asChild
                            isActive={isLibraryActive(library.id)}
                          >
                            <Link
                              to="/admin/libraries/$libraryId"
                              params={{ libraryId: String(library.id) }}
                              onClick={onNavigate}
                            >
                              <FontAwesomeIcon
                                icon={faLayerGroup}
                                className="h-3.5 w-3.5"
                              />
                              <span>{library.name || "Untitled Library"}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  )}
                </CollapsibleContent>
              </SidebarMenuSubItem>
            </Collapsible>
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
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

  const sortedServers = [...servers].sort((a, b) =>
    (a.server_nickname || "").localeCompare(b.server_nickname || "")
  )

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Media Servers</SidebarGroupLabel>
      <SidebarMenu>
        {sortedServers.map((server) => (
          <ServerNavItem
            key={server.id}
            server={server}
            pathname={location.pathname}
            onNavigate={handleNavLinkClick}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
