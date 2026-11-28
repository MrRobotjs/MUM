import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPlus, faServer } from '@fortawesome/free-solid-svg-icons'
import { type MediaService } from '../../hooks/useMediaServices'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ServiceSettingIcon } from '../users/AccountSettings'
import { MediaServiceFeatures } from './MediaServiceFeatures'
import { TestedVersionLine } from './TestedVersion'

export interface MediaServiceCardProps {
  service: MediaService
  /** The names of this service's servers, for the summary line. */
  serverNames: readonly string[]
  busy: boolean
  onToggle: (service: MediaService, on: boolean) => void
  onManage: (serviceId: string) => void
  onAddServer: (serviceId: string) => void
}

/**
 * One supported media service on the Media Servers page and in setup: its
 * servers, what MUM can do with it, an on/off switch for the whole service,
 * and the way into its servers.
 */
export const MediaServiceCard = ({ service, serverNames, busy, onToggle, onManage, onAddServer }: MediaServiceCardProps) => {
  const count = Math.max(service.serverCount, serverNames.length)
  const hasServers = count > 0
  const switchId = `media-service-${service.id}`
  const summary = hasServers
    ? `${count} server${count === 1 ? '' : 's'}${serverNames.length ? ` · ${serverNames.join(', ')}` : ''}`
    : 'No servers yet'
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <ServiceSettingIcon serviceType={service.id} />
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{service.name}</h2>
              <p className="truncate text-sm text-muted-foreground" title={summary}>{summary}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Label htmlFor={switchId} className="text-sm text-muted-foreground">{service.enabled ? 'On' : 'Off'}</Label>
            <Switch id={switchId} checked={service.enabled} disabled={busy || (!service.enabled && !hasServers)}
              onCheckedChange={on => onToggle(service, on)} aria-label={`Turn ${service.name} ${service.enabled ? 'off' : 'on'}`} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {service.description ? <p className="text-sm text-muted-foreground">{service.description}</p> : null}
        <TestedVersionLine service={service} />
        <MediaServiceFeatures features={service.features} />
        {!service.enabled && !hasServers ? <p className="text-xs text-muted-foreground">Add a server to turn {service.name} on.</p> : null}
        <div className="mt-auto flex flex-wrap gap-2">
          {hasServers ? (
            <>
              <Button size="sm" onClick={() => onManage(service.id)}><FontAwesomeIcon icon={faServer} />Manage servers</Button>
              <Button size="sm" variant="outline" onClick={() => onAddServer(service.id)}><FontAwesomeIcon icon={faPlus} />Add server</Button>
            </>
          ) : (
            <Button size="sm" onClick={() => onAddServer(service.id)}><FontAwesomeIcon icon={faPlus} />Add server</Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export default MediaServiceCard
