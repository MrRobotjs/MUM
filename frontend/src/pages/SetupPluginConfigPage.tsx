import { useMemo, useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { usePlugins } from '../hooks/usePlugins'
import { PluginConfiguration } from '../components/plugins/PluginConfiguration'
import { SetupLayout } from './SetupLayout'
import { ApiError } from '../util/apiClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleExclamation } from '@fortawesome/free-solid-svg-icons'
import { Spinner } from '@/components/ui/spinner'

function SetupPluginConfigContent() {
  const { pluginId } = useParams({ from: '/setup/media-servers/$pluginId' })
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
      window.location.href = `/admin/login?next=/setup/media-servers/${resolvedPluginId}`
    }
  }, [pluginsError, resolvedPluginId])

  if (pluginsLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4 text-muted-foreground" />
        Loading media service details…
      </div>
    )
  }

  if (pluginsError && !(pluginsError instanceof ApiError && pluginsError.status === 401)) {
    return (
      <Alert variant="destructive">
        <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
        <AlertTitle>Failed to load media services</AlertTitle>
        <AlertDescription>{(pluginsError as Error).message}</AlertDescription>
      </Alert>
    )
  }

  if (!plugin) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate({ to: '/setup/media-servers' })}>
          Back to Media Servers
        </Button>
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
          <AlertTitle>Media service not found</AlertTitle>
          <AlertDescription>Media service "{resolvedPluginId}" could not be located.</AlertDescription>
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
        addServerPath="/setup/media-servers/$pluginId/servers/add"
      />

      <div className="flex justify-between">
        <Button variant="outline" onClick={() => navigate({ to: '/setup/media-servers' })}>
          Back to Media Servers
        </Button>
        <Button onClick={() => navigate({ to: '/setup/app', replace: true })}>
          Continue to App Config
        </Button>
      </div>
    </div>
  )
}

export default function SetupPluginConfigPage() {
  const { pluginId } = useParams({ from: '/setup/media-servers/$pluginId' })
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


