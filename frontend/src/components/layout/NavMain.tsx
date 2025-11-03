"use client"

import { type Icon } from "@tabler/icons-react"
import { type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { IconDots } from "@tabler/icons-react"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export function NavMain({
  items,
}: {
  items: {
    title: string
    url: string
    icon?: Icon
    isActive?: boolean
    statusIndicator?: ReactNode
    actions?: {
      label: string
      icon?: Icon
      iconClassName?: string
      onClick: () => void
      disabled?: boolean
    }[]
  }[]
}) {
  const { isMobile, setOpenMobile } = useSidebar()

  const handleNavLinkClick = () => {
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton asChild tooltip={item.title} isActive={item.isActive}>
                <Link to={item.url} onClick={handleNavLinkClick}>
                  {item.icon && <item.icon />}
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
              {item.statusIndicator && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute right-8 top-2.5 flex items-center text-muted-foreground group-data-[collapsible=icon]:hidden"
                >
                  {item.statusIndicator}
                </span>
              )}
              {item.actions && item.actions.length > 0 && (() => {
                const actions = item.actions ?? []
                const allActionsDisabled = actions.every((action) => action.disabled)
                return (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <SidebarMenuAction
                        showOnHover
                        disabled={allActionsDisabled}
                        className={cn(
                          allActionsDisabled && 'opacity-40'
                        )}
                      >
                        <IconDots />
                        <span className="sr-only">More</span>
                      </SidebarMenuAction>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      className="w-48 rounded-lg"
                      side="bottom"
                      align="end"
                    >
                      {actions.map((action, idx) => (
                        <DropdownMenuItem
                          key={idx}
                          disabled={action.disabled}
                          onSelect={(event) => {
                            if (action.disabled) {
                              event.preventDefault()
                              return
                            }
                            action.onClick()
                          }}
                        >
                          {action.icon && (
                            <action.icon
                              className={cn("mr-2 h-4 w-4", action.iconClassName)}
                            />
                          )}
                          <span>{action.label}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )
              })()}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
