import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconAlertCircle, IconInfoCircle } from '@tabler/icons-react'

import { usePlugins, type Plugin } from '../hooks/usePlugins'
import { useServers } from '../hooks/useServers'
import { PageHeader } from '../components'
import { useAlerts } from '../contexts'
import { requestJson } from '../util/apiClient'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

const getPluginKey = (plugin: Plugin) => plugin.pluginId || plugin.id

export const PluginsPage = () => {
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

    const endpoint = `/admin/api/v1/plugins/${pluginId}/${action}`

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

  const groupedPlugins = useMemo(() => {
    const groups = {
      core: [] as Plugin[],
      community: [] as Plugin[],
    }

    for (const plugin of plugins) {
      const type = plugin.pluginType?.toLowerCase?.() ?? 'community'
      if (type === 'core') {
        groups.core.push(plugin)
      } else {
        groups.community.push(plugin)
      }
    }

    return groups
  }, [plugins])

  const renderPluginCard = (plugin: Plugin, isCommunity = false) => {
    const pluginKey = getPluginKey(plugin)
    const isLoading = actionLoading === pluginKey
    const statusBadge = plugin.installed
      ? plugin.enabled
        ? { label: 'Enabled', variant: 'success' as const }
        : { label: 'Disabled', variant: 'secondary' as const }
      : { label: 'Not Installed', variant: 'outline' as const }
    const serversConfigured =
      plugin.serversCount && plugin.serversCount > 0
        ? plugin.serversCount
        : serverCountByPlugin.get(plugin.pluginId.toLowerCase()) ?? 0
    const hasServers = serversConfigured > 0

    return (
      <Card
        key={pluginKey}
        className={cn(
          'h-full border border-border/50 shadow-sm',
          isCommunity ? 'bg-muted/40' : 'bg-background'
        )}
      >
        <CardContent className="flex h-full flex-col gap-4 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-lg font-semibold text-foreground">{plugin.name}</h3>
              {plugin.author ? (
                <p className="text-sm text-muted-foreground">by {plugin.author}</p>
              ) : null}
              {plugin.description ? (
                <p className="text-sm text-muted-foreground">{plugin.description}</p>
              ) : null}
            </div>
            <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
          </div>

          <div className="grid gap-3 text-sm text-muted-foreground">
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">Version</span>
              <span className="font-mono text-xs text-foreground">
                {plugin.version ?? '—'}
                {plugin.availableVersion && plugin.availableVersion !== plugin.version ? (
                  <span className="ml-2 text-xs text-warning">
                    Update: {plugin.availableVersion}
                  </span>
                ) : null}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">Servers</span>
              <span>
                {hasServers ? (
                  <span>{serversConfigured} configured</span>
                ) : (
                  <span className="text-destructive">No servers configured</span>
                )}
              </span>
            </div>
            {plugin.supportedFeatures?.length ? (
              <div>
                <span className="font-medium text-foreground">Features</span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {plugin.supportedFeatures.map((feature) => (
                    <Badge key={feature} variant="outline" className="text-xs">
                      {feature}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
            {plugin.lastError ? (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
                <span className="font-medium">Last error:</span> {plugin.lastError}
              </div>
            ) : null}
          </div>

          <Separator />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={plugin.enabled ? 'outline' : 'default'}
              onClick={() =>
                plugin.enabled
                  ? handleAction(plugin, 'disable')
                  : handleAction(plugin, 'enable')
              }
              disabled={isLoading || (!plugin.enabled && !hasServers)}
            >
              {isLoading ? 'Working…' : plugin.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate(`/admin/settings/plugins/${pluginKey}`)}
              disabled={isLoading}
            >
              Configure
            </Button>
            {plugin.repository_url ? (
              <Button
                asChild
                size="sm"
                variant="ghost"
                className="gap-2"
              >
                <a href={plugin.repository_url} target="_blank" rel="noopener noreferrer">
                  <i className="fa-brands fa-github" /> Repository
                </a>
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plugin Manager"
        description="Manage media service plugins and extend MUM's functionality."
      />

      {error ? (
        <Alert variant="destructive">
          <IconAlertCircle />
          <AlertTitle>Failed to load plugins</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="info">
          <IconInfoCircle />
          <AlertTitle>Plugin Management</AlertTitle>
          <AlertDescription>
            Enable and configure media service plugins to connect to your servers. Each
            plugin supports different capabilities and authentication methods.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Available Plugins</CardTitle>
          <p className="text-sm text-muted-foreground">
            {plugins.length} plugin{plugins.length === 1 ? '' : 's'} available
          </p>
        </CardHeader>
        <CardContent className="space-y-8">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="loading loading-spinner loading-sm" /> Loading plugins…
            </div>
          ) : plugins.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No plugins found. Install a plugin to get started.
            </div>
          ) : (
            <div className="space-y-10">
              {groupedPlugins.core.length ? (
                <section className="space-y-4">
                  <div>
                    <h3 className="text-lg font-semibold">Core Services</h3>
                    <p className="text-sm text-muted-foreground">
                      Built-in plugins maintained by MUM.
                    </p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {groupedPlugins.core.map((plugin) => renderPluginCard(plugin))}
                  </div>
                </section>
              ) : null}

              {groupedPlugins.community.length ? (
                <section className="space-y-4">
                  <div>
                    <h3 className="text-lg font-semibold">Community Plugins</h3>
                    <p className="text-sm text-muted-foreground">
                      Plugins contributed by the community.
                    </p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {groupedPlugins.community.map((plugin) =>
                      renderPluginCard(plugin, true)
                    )}
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  )
}

export default PluginsPage
