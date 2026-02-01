import { useMemo, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleInfo, faCircleExclamation } from '@fortawesome/free-solid-svg-icons'

import { usePlugins, type Plugin } from '../hooks/usePlugins'
import { useServers } from '../hooks/useServers'
import { PluginCard, PluginCardActions } from '../components/plugins'
import { SetupLayout } from './SetupLayout'
import { ApiError, requestJson } from '../util/apiClient'
import { useAlerts } from '../contexts'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'

const getPluginKey = (plugin: Plugin) => plugin.pluginId || plugin.id

function SetupPluginsContent() {
  const navigate = useNavigate()
  const { plugins, loading, error, refresh } = usePlugins()
  const { servers } = useServers({ activeOnly: true })
  const { success, error: showError } = useAlerts()
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // Handle authentication errors by redirecting to login
  useEffect(() => {
    if (error && error instanceof ApiError && error.status === 401) {
      // User is not authenticated, redirect to login with return path
      // Use window.location to ensure clean redirect without state issues
      window.location.href = '/admin/login?next=/setup/plugins'
    }
  }, [error])

  const serverCountByPlugin = useMemo(() => {
    const counts = new Map<string, number>()
    servers.forEach((server) => {
      if (!server?.service_type) return
      const key = server.service_type.toLowerCase()
      counts.set(key, (counts.get(key) ?? 0) + 1)
    })
    return counts
  }, [servers])

  const handleToggle = async (
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
      success(`Plugin "${plugin.name}" ${pastTense}.`)
      await refresh()
    } catch (err) {
      showError(
        `Failed to ${action} plugin: ${(err as Error).message}`
      )
    } finally {
      setActionLoading(null)
    }
  }

  const handleConfigure = (pluginKey: string) => {
    navigate({
      to: '/setup/plugins/$pluginId',
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
            onToggle={handleToggle}
            onConfigure={handleConfigure}
          />
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      {error && !(error instanceof ApiError && error.status === 401) ? (
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
          <AlertTitle>Error Loading Plugins</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : 'Failed to load plugins. Please try again.'}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="info">
          <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
          <AlertTitle>Plugin Setup</AlertTitle>
          <AlertDescription>
            Review the available plugins below. Click "Configure" on a plugin to enable it and add your servers.
          </AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading plugins…
        </div>
      ) : error ? (
        // Don't show plugins if there's an error
        null
      ) : plugins.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            No plugins found.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {plugins.map((plugin) => renderPluginCard(plugin))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Continue Setup</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-3">
          <Button variant="outline" onClick={() => navigate({ to: '/admin/settings/plugins' })}>
            Open Full Plugin Settings
          </Button>
          <Button onClick={() => navigate({ to: '/setup/app', replace: true })}>
            Continue to App Config
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

export default function SetupPluginsPage() {
  return (
    <SetupLayout
      stepId="plugins"
      title="Media Service Plugins"
      subtitle="Enable and configure your media service plugins, then add servers."
    >
      <SetupPluginsContent />
    </SetupLayout>
  )
}
