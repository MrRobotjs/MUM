import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { type Plugin } from '../../hooks/usePlugins'
import { useServers, type Server } from '../../hooks/useServers'
import { useAlerts } from '../../contexts'
import { requestJson } from '../../util/apiClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleExclamation, faCircleInfo } from '@fortawesome/free-solid-svg-icons'
import { Spinner } from '@/components/ui/spinner'

export interface PluginConfigurationProps {
  plugin: Plugin
  pluginId: string
  onServerAdded?: () => void
  showEditButton?: boolean
  addServerPath?: string
}

export const PluginConfiguration = ({
  plugin,
  pluginId,
  onServerAdded,
  showEditButton = true,
  addServerPath
}: PluginConfigurationProps) => {
  const navigate = useNavigate()
  const {
    servers,
    loading: serversLoading,
    error: serversError,
    refresh: refreshServers
  } = useServers({ serviceType: pluginId || undefined })

  const pluginServers = useMemo(() => {
    const target = pluginId.toLowerCase()
    return servers.filter((server) => (server.service_type || '').toLowerCase() === target)
  }, [servers, pluginId])

  const isPluginEnabled = plugin.enabledByUser

  const { success, error: showError } = useAlerts()

  const handleAddServer = () => {
    if (addServerPath) {
      navigate({ to: addServerPath as any, params: { pluginId } });
    } else {
      navigate({
        to: '/admin/settings/plugins/$pluginId/servers/add',
        params: { pluginId }
      });
    }
  }

  const handleToggleServerStatus = async (server: Server) => {
    if (!isPluginEnabled) {
      return
    }
    const newStatus = !server.is_active
    try {
      await requestJson(`/api/v2/servers/${server.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: newStatus })
      })
      success(`Server "${server.server_nickname}" ${newStatus ? 'enabled' : 'disabled'}`)
      await refreshServers()
    } catch (err) {
      showError(`Failed to update server status: ${(err as Error).message}`)
    }
  }

  const handleDeleteServer = async (server: Server) => {
    if (!confirm(`Remove server "${server.server_nickname}" from ${plugin?.name || 'plugin'}?`)) {
      return
    }

    try {
      await requestJson(`/api/v2/servers/${server.id}`, {
        method: 'DELETE'
      })
      success(`Server "${server.server_nickname}" removed`)
      await refreshServers()
    } catch (err) {
      showError(`Failed to delete server: ${(err as Error).message}`)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle>Plugin details</CardTitle>
          <CardDescription>
            {plugin.description || 'No description provided.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Author</dt>
              <dd className="text-foreground">{plugin.author ?? 'Unknown'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">License</dt>
              <dd className="text-foreground">{plugin.license ?? 'Not specified'}</dd>
            </div>
            {plugin.repository_url ? (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Repository</dt>
                <dd>
                  <a
                    className="text-primary underline underline-offset-4"
                    href={plugin.repository_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {plugin.repository_url}
                  </a>
                </dd>
              </div>
            ) : null}
            {plugin.homepage ? (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Homepage</dt>
                <dd>
                  <a
                    className="text-primary underline underline-offset-4"
                    href={plugin.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {plugin.homepage}
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>

          {plugin.supportedFeatures.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {plugin.supportedFeatures.map((feature) => (
                <Badge key={feature} variant="outline" className="text-xs">
                  {feature.replace(/_/g, ' ')}
                </Badge>
              ))}
            </div>
          ) : null}

          {plugin.lastError ? (
            <Alert variant="destructive">
              <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
              <AlertTitle>Plugin warning</AlertTitle>
              <AlertDescription>{plugin.lastError}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Configured servers</CardTitle>
            <CardDescription>Servers currently linked to this plugin.</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => refreshServers()}>
              Refresh
            </Button>
            <Button size="sm" onClick={handleAddServer}>
              Add Server
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {serversError ? (
            <Alert variant="destructive">
              <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
              <AlertTitle>Failed to load servers</AlertTitle>
              <AlertDescription>{(serversError as Error).message}</AlertDescription>
            </Alert>
          ) : null}

          {serversLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4 text-muted-foreground" />
              Loading servers…
            </div>
          ) : pluginServers.length === 0 ? (
            <Alert variant="info">
              <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
              <AlertTitle>No servers configured</AlertTitle>
              <AlertDescription>
                There are no servers linked to this plugin yet. Click "Add Server" to get started.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {pluginServers.map((server) => (
                <Card key={server.id} className="border border-border/60">
                  <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div>
                      <CardTitle className="text-base">
                        {server.server_nickname}
                      </CardTitle>
                      <CardDescription>
                        {server.server_name ?? 'No remote name'}
                      </CardDescription>
                    </div>
                    <Badge variant={server.is_active ? 'success' : 'outline'}>
                      {server.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm text-muted-foreground">
                    <div>
                      <span className="font-medium text-foreground">URL:</span>{' '}
                      <a
                        className="text-primary underline underline-offset-4 break-all"
                        href={server.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {server.url}
                      </a>
                    </div>
                    {server.public_url ? (
                      <div>
                        <span className="font-medium text-foreground">Public URL:</span>{' '}
                        <a
                          className="text-primary underline underline-offset-4 break-all"
                          href={server.public_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {server.public_url}
                        </a>
                      </div>
                    ) : null}
                    {server.service_type === 'plex' ? (
                      <div>
                        <span className="font-medium text-foreground">WebSocket refresh:</span>{' '}
                        {(server.websocket_refresh_interval ?? 30).toString()}s
                      </div>
                    ) : null}
                    {server.last_sync_at ? (
                      <div>
                        <span className="font-medium text-foreground">Last Sync:</span>{' '}
                        {new Date(server.last_sync_at).toLocaleString()}
                      </div>
                    ) : null}
                    {server.overseerr_enabled ? (
                      <div>
                        <span className="font-medium text-foreground">Overseerr:</span>{' '}
                        {server.overseerr_url ? (
                          <a
                            className="text-primary underline underline-offset-4 break-all"
                            href={server.overseerr_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {server.overseerr_url}
                          </a>
                        ) : (
                          'Enabled'
                        )}
                      </div>
                    ) : null}

                    <Separator />

                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <Switch
                            id={`server-${server.id}-status`}
                            checked={server.is_active}
                            onCheckedChange={() => handleToggleServerStatus(server)}
                            disabled={!isPluginEnabled}
                          />
                          <Label htmlFor={`server-${server.id}-status`} className="text-sm cursor-pointer">
                            {server.is_active ? 'Enabled' : 'Disabled'}
                          </Label>
                        </div>
                        {!isPluginEnabled ? (
                          <span className="text-xs text-muted-foreground">
                            Enable the plugin to change server status.
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {showEditButton && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              navigate({
                                to: '/admin/settings/plugins/$pluginId/servers/$serverId',
                                params: { pluginId, serverId: String(server.id) }
                              })
                            }
                          >
                            Edit
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleDeleteServer(server)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default PluginConfiguration
