import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleExclamation, faCircleInfo } from '@fortawesome/free-solid-svg-icons'

import { usePlugins, type Plugin } from '../hooks/usePlugins'
import { useServers } from '../hooks/useServers'
import { PageHeader } from '../components'
import { useAlerts } from '../contexts'
import { requestPluginMutation } from '../util/pluginMutations'
import { PluginCard, PluginCardActions } from '../components/plugins'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'

const getPluginKey = (plugin: Plugin) => plugin.pluginId || plugin.id

const PluginCardSkeleton = () => (
  <div className="h-full rounded-lg border border-border/50 bg-card p-4 shadow-sm space-y-4">
    <div className="flex items-start justify-between gap-4">
      <Skeleton className="h-10 w-10 rounded-md" />
      <Skeleton className="h-6 w-20 rounded-full" />
    </div>
    <div className="space-y-2">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-56" />
    </div>
    <div className="space-y-2">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-4 w-32" />
    </div>
    <div className="flex gap-2">
      <Skeleton className="h-9 w-24" />
      <Skeleton className="h-9 w-20" />
    </div>
  </div>
)

export const AdminSettingsPluginsPage = () => {
  const navigate = useNavigate()
  const { plugins, loading, error } = usePlugins()
  const { success, error: showError } = useAlerts()
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const { servers } = useServers()

  const serverCountByPlugin = useMemo(() => {
    const counts = new Map<string, number>()
    servers.forEach((server) => {
      if (!server?.service_type) return
      const key = server.service_type.toLowerCase()
      counts.set(key, (counts.get(key) ?? 0) + 1)
    })
    return counts
  }, [servers])

  const handleAction = async (
    plugin: Plugin,
    action: 'enable' | 'disable'
  ) => {
    const pluginId = getPluginKey(plugin)
    if (!pluginId) {
      showError('Media service identifier missing; cannot perform action.')
      return
    }

    const endpoint = action === 'enable'
      ? `/api/providers/${pluginId}/enable`
      : `/api/providers/${pluginId}/disable`

    setActionLoading(pluginId)
    try {
      await requestPluginMutation(endpoint, { method: 'POST' })
      const pastTense = {
        enable: 'enabled',
        disable: 'disabled',
      }[action]
      success(`Plugin "${plugin.name}" ${pastTense}`)
    } catch (err) {
      showError(
        `Failed to ${action} plugin: ${(err as Error).message ?? 'Unknown error'}`
      )
    } finally {
      setActionLoading(null)
    }
  }

  // Media providers are compiled into MUM: there is nothing to install or
  // uninstall at runtime, so these controls never send a request.
  const handleUninstall = async (plugin: Plugin) => {
    showError(`"${plugin.name}" is compiled into MUM and cannot be uninstalled. Disable it instead.`)
  }


  const handleConfigure = (pluginKey: string) => {
    navigate({
      to: '/admin/settings/media-servers/$pluginId',
      params: { pluginId: pluginKey } as any
    })
  }

  const renderPluginCard = (plugin: Plugin) => {
    const pluginKey = getPluginKey(plugin)
    const isLoading = actionLoading === pluginKey
    const serversConfigured =
      plugin.serversCount && plugin.serversCount > 0
        ? plugin.serversCount
        : serverCountByPlugin.get(plugin.pluginId.toLowerCase()) ?? 0
    const hasServers = serversConfigured > 0

    return (
      <PluginCard
        key={pluginKey}
        plugin={plugin}
        serversConfigured={serversConfigured}
        actions={
          <PluginCardActions
            plugin={plugin}
            pluginKey={pluginKey}
            hasServers={hasServers}
            isLoading={isLoading}
            onToggle={handleAction}
            onConfigure={handleConfigure}
            onUninstall={handleUninstall}
          />
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Media Servers"
        description="Enable media services and manage their servers."
      />

      {error ? (
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
          <AlertTitle>Failed to load media services</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="info">
          <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
          <AlertTitle>Supported Media Services</AlertTitle>
          <AlertDescription>
            Enable a media service, then add and configure your servers for it.
            Every supported service is built into MUM.
          </AlertDescription>
        </Alert>
      )}

      <div>
        <div className="space-y-8">
          {loading ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }).map((_, idx) => (
                <PluginCardSkeleton key={idx} />
              ))}
            </div>
          ) : plugins.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No media services found.
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {plugins.map((plugin) => renderPluginCard(plugin))}
            </div>
          )}
        </div>
      </div>

    </div>
  )
}

export default AdminSettingsPluginsPage
