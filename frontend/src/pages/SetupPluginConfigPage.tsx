import { useMemo, useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { usePlugins } from '../hooks/usePlugins'
import { PluginConfiguration } from '../components/plugins/PluginConfiguration'
import { SetupLayout } from './SetupLayout'
import { ApiError } from '../util/apiClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { IconAlertCircle } from '@tabler/icons-react'

function SetupPluginConfigContent() {
  const { pluginId } = useParams({ from: '/setup/plugins/$pluginId' })
  const resolvedPluginId = pluginId ?? ''
  const navigate = useNavigate()
  const { plugins, loading: pluginsLoading, error: pluginsError } = usePlugins()
  const plugin = useMemo(
    () => plugins.find((item) => item.pluginId === resolvedPluginId),
    [plugins, resolvedPluginId]
  )

  // Handle authentication errors by redirecting to login
  useEffect(() => {
    if (pluginsError && pluginsError instanceof ApiError && pluginsError.status === 401) {
      window.location.href = `/admin/login?next=/setup/plugins/${resolvedPluginId}`
    }
  }, [pluginsError, resolvedPluginId])

  if (pluginsLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        Loading plugin details…
      </div>
    )
  }

  if (pluginsError && !(pluginsError instanceof ApiError && pluginsError.status === 401)) {
    return (
      <Alert variant="destructive">
        <IconAlertCircle />
        <AlertTitle>Failed to load plugins</AlertTitle>
        <AlertDescription>{(pluginsError as Error).message}</AlertDescription>
      </Alert>
    )
  }

  if (!plugin) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate({ to: '/setup/plugins' })}>
          Back to Plugins
        </Button>
        <Alert variant="destructive">
          <IconAlertCircle />
          <AlertTitle>Plugin not found</AlertTitle>
          <AlertDescription>Plugin "{resolvedPluginId}" could not be located.</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PluginConfiguration
        plugin={plugin}
        pluginId={resolvedPluginId}
        showEditButton={false}
        addServerPath="/setup/plugins/$pluginId/servers/add"
      />

      <div className="flex justify-between">
        <Button variant="outline" onClick={() => navigate({ to: '/setup/plugins' })}>
          Back to Plugins
        </Button>
        <Button onClick={() => navigate({ to: '/setup/app', replace: true })}>
          Continue to App Config
        </Button>
      </div>
    </div>
  )
}

export default function SetupPluginConfigPage() {
  const { pluginId } = useParams({ from: '/setup/plugins/$pluginId' })
  const { plugins } = usePlugins()
  const plugin = useMemo(
    () => plugins.find((item) => item.pluginId === pluginId),
    [plugins, pluginId]
  )

  return (
    <SetupLayout
      stepId="plugins"
      title={plugin ? `Configure ${plugin.name}` : 'Configure Plugin'}
      subtitle="Add and configure servers for this media service plugin."
    >
      <SetupPluginConfigContent />
    </SetupLayout>
  )
}



