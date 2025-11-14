import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { IconInfoCircle } from '@tabler/icons-react'

import { usePlugins, type Plugin } from '../hooks/usePlugins'
import { useServers } from '../hooks/useServers'
import { PluginCard } from '../components/plugins'
import { SetupLayout } from './SetupLayout'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const getPluginKey = (plugin: Plugin) => plugin.pluginId || plugin.id

function SetupPluginsContent() {
  const navigate = useNavigate()
  const { plugins, loading } = usePlugins()
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

  const renderPluginCard = (plugin: Plugin) => {
    const pluginKey = getPluginKey(plugin)
    const serversConfigured =
      plugin.serversCount && plugin.serversCount > 0
        ? plugin.serversCount
        : serverCountByPlugin.get(plugin.pluginId.toLowerCase()) ?? 0

    return (
      <PluginCard
        key={pluginKey}
        plugin={plugin}
        serversConfigured={serversConfigured}
        actions={
          <Button
            size="sm"
            variant="default"
            onClick={() => {
              navigate({
                to: '/admin/settings/plugins/$pluginId',
                params: { pluginId: pluginKey } as any
              })
            }}
          >
            Configure
          </Button>
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      <Alert variant="info">
        <IconInfoCircle />
        <AlertTitle>Plugin Setup</AlertTitle>
        <AlertDescription>
          Review the available plugins below. Click "Configure" on a plugin to enable it and add your servers.
        </AlertDescription>
      </Alert>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="loading loading-spinner loading-sm" /> Loading plugins…
        </div>
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
          <Button onClick={() => navigate({ to: '/setup/discord', replace: true })}>
            Continue to Discord Setup
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