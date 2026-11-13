import { Badge } from "@/components/ui/badge"

/** The small count shown beside a sidebar item (users, libraries). On the
 * highlighted item it turns darker so it stays visible against the highlight. */
export const SidebarCount = ({ value, singular, plural }: { value: number; singular: string; plural: string }) => (
  <Badge
    variant="default"
    title={`${value.toLocaleString()} ${value === 1 ? singular : plural}`}
    className="flex h-5 min-w-5 items-center justify-center border-transparent bg-sidebar-accent px-1 text-[10px] leading-none font-semibold text-sidebar-accent-foreground in-data-[active=true]:bg-sidebar"
  >
    {value.toLocaleString()}
  </Badge>
)
