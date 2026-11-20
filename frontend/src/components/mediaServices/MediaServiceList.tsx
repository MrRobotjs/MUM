import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { type MediaService } from '../../hooks/useMediaServices'
import { useServers } from '../../hooks/useServers'
import { useMediaServiceToggle } from '../../hooks/useMediaServiceToggle'
import { Skeleton } from '@/components/ui/skeleton'
import { MediaServiceCard } from './MediaServiceCard'

const MediaServiceCardSkeleton = () => (
  <div className="h-full space-y-4 rounded-xl border bg-card p-6 shadow-sm">
    <div className="flex items-center gap-3">
      <Skeleton className="size-10 rounded-full" />
      <div className="space-y-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-40" />
      </div>
    </div>
    <Skeleton className="h-40 w-full rounded-lg" />
    <Skeleton className="h-9 w-32" />
  </div>
)

const grid = 'grid gap-4 md:grid-cols-2 xl:grid-cols-3'

/**
 * The supported media services as cards: the ones turned on first, then the
 * rest under Available. Shared by Settings → Media Servers and setup, which
 * differ only in where a service's servers are managed.
 */
export const MediaServiceList = ({ services, loading, setup = false }: { services: readonly MediaService[]; loading: boolean; setup?: boolean }) => {
  const navigate = useNavigate()
  const { servers } = useServers()
  const { busy, toggle } = useMediaServiceToggle()

  const serverNames = useMemo(() => {
    const names = new Map<string, string[]>()
    for (const server of servers) {
      const kind = (server.service_type || '').toLowerCase()
      names.set(kind, [...(names.get(kind) ?? []), server.server_nickname])
    }
    return names
  }, [servers])

  const manage = (serviceId: string) => setup
    ? navigate({ to: '/setup/media-servers/$serviceId', params: { serviceId } })
    : navigate({ to: '/admin/settings/media-servers/$serviceId', params: { serviceId } })
  const addServer = (serviceId: string) => setup
    ? navigate({ to: '/setup/media-servers/$serviceId/servers/add', params: { serviceId } })
    : navigate({ to: '/admin/settings/media-servers/$serviceId/servers/add', params: { serviceId } })

  if (loading) return <div className={grid}>{Array.from({ length: 3 }).map((_, i) => <MediaServiceCardSkeleton key={i} />)}</div>
  if (services.length === 0) {
    return <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No media services found.</div>
  }
  const card = (service: MediaService) => (
    <MediaServiceCard key={service.id} service={service} serverNames={serverNames.get(service.id) ?? []} busy={busy === service.id}
      onToggle={toggle} onManage={manage} onAddServer={addServer} />
  )
  const on = services.filter(s => s.enabled), available = services.filter(s => !s.enabled)
  return (
    <div className="space-y-8">
      {on.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Turned on</h2>
          <div className={grid}>{on.map(card)}</div>
        </section>
      )}
      {available.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Available</h2>
          <div className={grid}>{available.map(card)}</div>
        </section>
      )}
    </div>
  )
}

export default MediaServiceList
