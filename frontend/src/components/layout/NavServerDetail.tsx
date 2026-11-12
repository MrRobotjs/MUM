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

type ServerPage = { to: string; suffix: string; title: string; icon: IconDefinition }

const serverPages: ServerPage[] = [
  { to: "/admin/servers/$serverId", suffix: "", title: "Overview", icon: faCircleInfo },
  { to: "/admin/servers/$serverId/users", suffix: "/users", title: "Users", icon: faUsers },
  { to: "/admin/servers/$serverId/libraries", suffix: "/libraries", title: "Libraries", icon: faDatabase },
]

// Sidebar group shown on a server's page, like the settings sidebar: the
// server's name as the label and links to its pages. The name comes from
// the same cached server read the page itself uses.
export function NavServerDetail({ serverId }: { serverId: number }) {
  const { isMobile, setOpenMobile } = useSidebar()
  const { server } = useServerDetail(serverId)
  const path = useLocation().pathname.replace(/\/$/, "")
  const label = server?.server_nickname || `Server ${serverId}`

  return (
    <SidebarGroup>
      <SidebarGroupLabel title={label}>
        <span className="truncate">{label}</span>
      </SidebarGroupLabel>
      <SidebarMenu>
        {serverPages.map((item) => (
          <SidebarMenuItem key={item.title}>
            <SidebarMenuButton asChild tooltip={item.title} isActive={path === `/admin/servers/${serverId}${item.suffix}`}>
              <Link
                to={item.to}
                params={{ serverId: String(serverId) }}
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
