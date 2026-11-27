import { appPaths, appLinks } from '../../router/appLinks';
import { serverNicknameSlug } from '../../lib/serverNickname';
import { useServerRoutes } from '../../lib/serverRoutes';
import { useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowUpRightFromSquare, faCircleExclamation, faPen, faPlus, faServer, faTrash } from '@fortawesome/free-solid-svg-icons'
import { useAccountDisplay } from '../../hooks/useAccountDisplay'
import { type MediaService } from '../../hooks/useMediaServices'
import { useMediaServiceToggle } from '../../hooks/useMediaServiceToggle'
import { useServers, type Server } from '../../hooks/useServers'
import { useAlerts } from '../../contexts'
import { ApiError, requestJson } from '../../util/apiClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmAction, ServiceSettingIcon, TabHeading } from '../users/AccountSettings'
import { Row } from '../library/LibraryOverview'
import { MediaServiceFeatures } from './MediaServiceFeatures'

export interface MediaServiceServersProps {
  service: MediaService
  /** In the setup wizard: servers are added from setup, and edited later in Settings. */
  setup?: boolean
}

const ExternalLink = ({ href }: { href: string }) => (
  <a className="text-primary underline-offset-4 hover:underline wrap-break-word" href={href} target="_blank" rel="noopener noreferrer">{href}</a>
)

/**
 * A media service's page: the service (on/off and what MUM can do with it),
 * then its servers, each with its details, its own on/off switch, and Open,
 * Edit and Remove.
 */
export const MediaServiceServers = ({ service, setup = false }: MediaServiceServersProps) => {
  const routes = useServerRoutes()
  const { formatTimestamp, formatRelative } = useAccountDisplay()
  const navigate = useNavigate()
  const { success, error: showError } = useAlerts()
  const { busy: serviceBusy, toggle: toggleService } = useMediaServiceToggle()
  const { servers, loading, error, refresh } = useServers({ serviceType: service.id })
  const [pending, setPending] = useState<number | null>(null)
  const [removing, setRemoving] = useState<Server | null>(null)

  const serviceServers = useMemo(
    () => servers.filter(server => (server.service_type || '').toLowerCase() === service.id),
    [servers, service.id])
  const onCount = serviceServers.filter(server => server.is_active).length
  const switchId = `media-service-${service.id}`

  const addServer = () => setup
    ? navigate({ to: '/setup/media-servers/$serviceId/servers/add', params: { serviceId: service.id } })
    : navigate(appLinks.serverAdd(service.id))

  const toggleServer = async (server: Server) => {
    if (!service.enabled || pending !== null) return
    const on = !server.is_active
    setPending(server.id)
    try {
      await requestJson(`/api/servers/${server.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: on }) })
      success(`${server.server_nickname} turned ${on ? 'on' : 'off'}.`)
      await refresh()
    } catch (err) {
      showError(`Couldn’t turn ${server.server_nickname} ${on ? 'on' : 'off'}: ${(err as Error).message}`)
    } finally {
      setPending(null)
    }
  }

  const removeServer = async () => {
    if (!removing) return
    const server = removing
    setPending(server.id)
    try {
      await requestJson(`/api/servers/${server.id}`, { method: 'DELETE' })
      success(`${server.server_nickname} removed.`)
      setRemoving(null)
      await refresh()
    } catch (err) {
      // The dialog closes either way so the reason shows; nothing is retried.
      setRemoving(null)
      showError(err instanceof ApiError && err.status === 409
        ? `${server.server_nickname} still has accounts, libraries, history or invites in MUM, so it’s kept. Turn it off instead.`
        : `Couldn’t remove ${server.server_nickname}: ${(err as Error).message}`)
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <ServiceSettingIcon serviceType={service.id} />
              <div className="min-w-0">
                <h2 className="text-xl font-semibold">{service.name}</h2>
                {service.description ? <p className="text-sm text-muted-foreground">{service.description}</p> : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Label htmlFor={switchId} className="text-sm text-muted-foreground">{service.enabled ? 'On' : 'Off'}</Label>
              <Switch id={switchId} checked={service.enabled} disabled={serviceBusy !== null || (!service.enabled && serviceServers.length === 0)}
                onCheckedChange={on => void toggleService(service, on)} aria-label={`Turn ${service.name} ${service.enabled ? 'off' : 'on'}`} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">What MUM can do with {service.name}</p>
          <MediaServiceFeatures features={service.features} columns />
          {!service.enabled ? (
            <p className="text-xs text-muted-foreground">
              {serviceServers.length ? `${service.name} is off: MUM doesn’t sync, monitor or invite to its servers until it’s turned on.` : `Add a server to turn ${service.name} on.`}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <TabHeading icon={faServer} title="Servers"
              description={loading && !serviceServers.length ? `${service.name} servers MUM manages`
                : serviceServers.length ? `${serviceServers.length} server${serviceServers.length === 1 ? '' : 's'} · ${onCount} on` : `No ${service.name} servers yet`} />
            <Button size="sm" onClick={addServer}><FontAwesomeIcon icon={faPlus} />Add server</Button>
          </div>
        </CardHeader>
        <CardContent>
          {error ? (
            <Alert variant="destructive">
              <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
              <AlertTitle>Failed to load servers</AlertTitle>
              <AlertDescription>{(error as Error).message}</AlertDescription>
            </Alert>
          ) : loading && !serviceServers.length ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" />Loading servers…</div>
          ) : serviceServers.length === 0 ? (
            <div className="rounded-lg border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
              Add a {service.name} server to start managing its users, libraries and activity.
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {serviceServers.map(server => {
                const serverSwitch = `server-${server.id}-on`
                return (
                  <div key={server.id} className="space-y-4 rounded-lg border border-border/70 bg-muted/40 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h3 className="truncate font-semibold">{server.server_nickname}</h3>
                        <p className="truncate text-sm text-muted-foreground">{server.server_name || 'No name reported yet'}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Label htmlFor={serverSwitch} className="text-sm text-muted-foreground">{server.is_active ? 'On' : 'Off'}</Label>
                        <Switch id={serverSwitch} checked={server.is_active} disabled={!service.enabled || pending !== null}
                          onCheckedChange={() => void toggleServer(server)} aria-label={`Turn ${server.server_nickname} ${server.is_active ? 'off' : 'on'}`} />
                      </div>
                    </div>
                    <div className="space-y-2 text-sm">
                      <Row label="Address"><ExternalLink href={server.url} /></Row>
                      {server.public_url ? <Row label="Public address"><ExternalLink href={server.public_url} /></Row> : null}
                      <Row label="Last synced">
                        {server.last_sync_at ? <span title={formatTimestamp(server.last_sync_at)}>{formatRelative(server.last_sync_at)}</span> : 'Not synced yet'}
                      </Row>
                      {server.overseerr_enabled ? <Row label="Overseerr">{server.overseerr_url ? <ExternalLink href={server.overseerr_url} /> : 'On'}</Row> : null}
                    </div>
                    {!service.enabled ? <p className="text-xs text-muted-foreground">Turn {service.name} on to change this server’s switch.</p> : null}
                    <div className="flex flex-wrap gap-2">
                      {!setup ? (
                        <>
                          <Button asChild size="sm" variant="outline">
                            <Link {...appLinks.server(`${service.id}/${serverNicknameSlug(server.server_nickname)}`)}><FontAwesomeIcon icon={faArrowUpRightFromSquare} />Open server</Link>
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => navigate(appLinks.serverEdit(service.id, routes.settingsSlug({...server, service_type: service.id})))}>
                            <FontAwesomeIcon icon={faPen} />Edit
                          </Button>
                        </>
                      ) : null}
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRemoving(server)} disabled={pending !== null}>
                        <FontAwesomeIcon icon={faTrash} />Remove
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmAction open={removing !== null} onOpenChange={open => { if (!open) setRemoving(null) }} title={`Remove ${removing?.server_nickname ?? 'server'}?`}
        confirmLabel="Remove server" destructive busy={pending !== null} onConfirm={() => void removeServer()}>
        <p>MUM removes a server only while it holds nothing for it: no accounts, libraries, history or invites. A server that has them is kept; turn it off instead. The {service.name} server itself isn’t changed.</p>
      </ConfirmAction>
    </div>
  )
}

export default MediaServiceServers
