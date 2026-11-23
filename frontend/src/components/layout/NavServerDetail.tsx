import { appPaths, serverRoutePath } from '../../router/appLinks';
"use client"

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core"
import { faCircleInfo, faDatabase, faUsers } from "@fortawesome/free-solid-svg-icons"
import { Link, useLocation } from "@tanstack/react-router"

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useServerDetail } from "@/hooks/useServers"
import { serverNicknameSlug } from "@/lib/serverNickname"

type ServerPage = { to: string; suffix: string; title: string; icon: IconDefinition }

const serverPages: ServerPage[] = [
  { to: appPaths.server, suffix: "", title: "Overview", icon: faCircleInfo },
  { to: appPaths.serverUsers, suffix: "/users", title: "Users", icon: faUsers },
  { to: appPaths.serverLibraries, suffix: "/libraries", title: "Libraries", icon: faDatabase },
]

// Sidebar group shown on a server's page, like the settings sidebar: the
// server's name as the label and links to its pages. The name comes from
// the same cached server read the page itself uses.
export function NavServerDetail({ serverId }: { serverId: number }) {
  const { isMobile, setOpenMobile } = useSidebar()
  const { server } = useServerDetail(serverId)
  const path = useLocation().pathname.replace(/\/$/, "")
  const label = server?.server_nickname || `Server ${serverId}`
  const slug = server?.server_nickname ? `${server.service_type}/${serverNicknameSlug(server.server_nickname)}` : ""

  return (
    <SidebarGroup>
      <SidebarGroupLabel title={label}>
        <span className="truncate">{label}</span>
      </SidebarGroupLabel>
      <SidebarMenu>
        {serverPages.map((item) => (
          <SidebarMenuItem key={item.title}>
            <SidebarMenuButton asChild tooltip={item.title} isActive={path === serverRoutePath(item.to, slug)}>
              <Link
                to={item.to}
                params={{ serverType: server?.service_type ?? "", serverId: server?.server_nickname ? serverNicknameSlug(server.server_nickname) : "" }}
                onClick={() => {
                  if (isMobile) setOpenMobile(false)
                }}
              >
                <FontAwesomeIcon icon={item.icon} className="h-4 w-4" />
                <span>{item.title}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
