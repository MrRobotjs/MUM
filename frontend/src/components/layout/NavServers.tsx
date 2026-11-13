"use client"

import * as React from "react"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import {
  faChevronRight,
  faCircleInfo,
  faGear,
  faLayerGroup,
  faRotate,
  faServer,
  faUsers,
} from "@fortawesome/free-solid-svg-icons"
import { Link, useLocation } from "@tanstack/react-router"

import { useServerOptions } from "@/hooks/useServerOptions"
import { useServerLibraries } from "@/hooks/useServerLibraries"
import { useUserTotal } from "@/hooks/useUserTotal"
import { SidebarCount } from "@/components/layout/SidebarCount"
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

// A server's own pages, in sidebar order.
const serverPages = [
  { title: "Overview", suffix: "", to: "/admin/servers/$serverId", icon: faCircleInfo },
  { title: "Users", suffix: "/users", to: "/admin/servers/$serverId/users", icon: faUsers },
  { title: "Libraries", suffix: "/libraries", to: "/admin/servers/$serverId/libraries", icon: faLayerGroup },
] as const

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

  // The server being viewed opens by itself (it can still be closed).
  const serverPath = `/admin/servers/${server.id}`
  const onServerPage = pathname === serverPath || pathname.startsWith(`${serverPath}/`)
  const [open, setOpen] = React.useState(onServerPage)
  React.useEffect(() => {
    if (onServerPage) {
      setOpen(true)
      requestLibraries()
    }
  }, [onServerPage, requestLibraries])

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
    <SidebarCount value={libraryCount} singular="library" plural="libraries" />
  ) : null
  // This server's service accounts, as its Users page lists them; read once
  // the server's entry is open, like its libraries.
  const userTotal = useUserTotal({ serverId: server.id, enabled: open })

  return (
    <Collapsible
      asChild
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          requestLibraries()
        }
      }}
    >
      {/* Collapsed with this server open, one tray runs from the server's
          icon through its page icons. */}
      <SidebarMenuItem className={open ? "group-data-[collapsible=icon]:rounded-md group-data-[collapsible=icon]:bg-sidebar-accent/50 group-data-[collapsible=icon]:pb-0.5" : undefined}>
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
            to="/admin/settings/media-servers/$pluginId/servers/$serverId"
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
            {/* The server's own pages; Libraries below expands its library list. */}
            <SidebarMenuSubItem>
              <SidebarMenuSubButton asChild isActive={pathname === `/admin/servers/${server.id}`}>
                <Link to="/admin/servers/$serverId" params={{ serverId: String(server.id) }} activeOptions={{ exact: true }} onClick={onNavigate}>
                  <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
                  <span>Overview</span>
                </Link>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
            <SidebarMenuSubItem>
              <SidebarMenuSubButton asChild isActive={pathname === `/admin/servers/${server.id}/users`}>
                <Link to="/admin/servers/$serverId/users" params={{ serverId: String(server.id) }} onClick={onNavigate}>
                  <FontAwesomeIcon icon={faUsers} className="h-4 w-4" />
                  <span>Users</span>
                  {userTotal !== null && (
                    <span className="flex items-center justify-center">
                      <SidebarCount value={userTotal} singular="user" plural="users" />
                    </span>
                  )}
                </Link>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
            <Collapsible
              asChild
              onOpenChange={(open) => {
                if (open) {
                  requestLibraries()
                }
              }}
            >
              <SidebarMenuSubItem className="relative">
                {/* The label opens the server's Libraries page; the arrow
                    shows or hides its library list. */}
                <SidebarMenuSubButton asChild isActive={pathname === `${serverPath}/libraries`} className="pr-8">
                  <Link to="/admin/servers/$serverId/libraries" params={{ serverId: String(server.id) }} onClick={onNavigate}>
                    <FontAwesomeIcon icon={faLayerGroup} className="h-4 w-4" />
                    <span>Libraries</span>
                    {libraryMeta && (
                      <span className="flex items-center justify-center">
                        {libraryMeta}
                      </span>
                    )}
                  </Link>
                </SidebarMenuSubButton>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Show ${server.server_nickname} libraries`}
                    className="absolute right-1 top-3.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  >
                    <FontAwesomeIcon
                      icon={faChevronRight}
                      className="text-[10px] transition-transform duration-200 group-data-[state=open]/menu-sub-item:rotate-90"
                    />
                  </button>
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
        {/* Collapsed to icons (desktop only): an open server shows its pages
            as a small rail under its icon, the current one highlighted.
            Clicking a server's icon opens or closes it; the server being
            viewed opens by itself. Expanded and on phones the list above
            shows these pages. */}
        {open && (
          <div className="mt-0.5 hidden flex-col items-center gap-0.5 group-data-[collapsible=icon]:flex">
            {serverPages.map((page) => (
              <SidebarMenuButton
                key={page.title}
                asChild
                tooltip={`${server.server_nickname} · ${page.title}`}
                isActive={pathname === `${serverPath}${page.suffix}`}
                className="text-sidebar-foreground/70 data-[active=true]:text-sidebar-accent-foreground [&>svg]:size-3.5"
              >
                <Link
                  to={page.to}
                  params={{ serverId: String(server.id) }}
                  activeOptions={{ exact: true }}
                  onClick={onNavigate}
                  aria-label={`${server.server_nickname} ${page.title}`}
                >
                  <FontAwesomeIcon icon={page.icon} />
                  <span>{page.title}</span>
                </Link>
              </SidebarMenuButton>
            ))}
          </div>
        )}
      </SidebarMenuItem>
    </Collapsible >
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
