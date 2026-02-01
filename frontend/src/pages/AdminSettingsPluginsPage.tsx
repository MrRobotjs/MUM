import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleExclamation, faCircleInfo } from '@fortawesome/free-solid-svg-icons'

import { usePlugins, type Plugin } from '../hooks/usePlugins'
import { useServers } from '../hooks/useServers'
import { PageHeader } from '../components'
import { useAlerts } from '../contexts'
import { requestJson } from '../util/apiClient'
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
  const { plugins, loading, error, refresh } = usePlugins()
  const { success, error: showError } = useAlerts()
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const { servers } = useServers({ activeOnly: true })

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
      showError('Plugin identifier missing; cannot perform action.')
      return
    }

    const endpoint = action === 'enable'
      ? `/admin/api/v2/plugins/${pluginId}/enable`
      : `/admin/api/v2/plugins/${pluginId}/disable`

    setActionLoading(pluginId)
    try {
      await requestJson(endpoint, { method: 'POST' })
      const pastTense = {
        enable: 'enabled',
        disable: 'disabled',
      }[action]
      success(`Plugin "${plugin.name}" ${pastTense}`)
      await refresh()
    } catch (err) {
      showError(
        `Failed to ${action} plugin: ${(err as Error).message ?? 'Unknown error'}`
      )
    } finally {
      setActionLoading(null)
    }
  }

  const handleConfigure = (pluginKey: string) => {
    navigate({
      to: '/admin/settings/plugins/$pluginId',
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
          />
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Media Service Plugins"
        description="Manage built-in media service plugins for MUM."
      />

      {error ? (
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
          <AlertTitle>Failed to load plugins</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="info">
          <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
          <AlertTitle>Built-in Plugins</AlertTitle>
          <AlertDescription>
            Enable and configure built-in media service plugins to connect to your servers.
            All plugins are developed and maintained in-house by the MUM team.
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
              No plugins found.
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
