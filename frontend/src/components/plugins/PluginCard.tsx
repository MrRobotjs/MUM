import { type ReactNode } from 'react'
import { type Plugin } from '../../hooks/usePlugins'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'

export interface PluginCardProps {
  plugin: Plugin
  serversConfigured?: number
  actions?: ReactNode
  className?: string
}

export const PluginCard = ({
  plugin,
  serversConfigured = 0,
  actions,
  className = ''
}: PluginCardProps) => {
  const statusBadge = plugin.installed
    ? plugin.enabled
      ? { label: 'Enabled', variant: 'success' as const }
      : { label: 'Disabled', variant: 'secondary' as const }
    : { label: 'Not Installed', variant: 'outline' as const }

  const hasServers = serversConfigured > 0

  return (
    <Card className={`h-full border border-border/50 shadow-sm bg-card ${className}`}>
      <CardContent className="flex h-full flex-col gap-4">
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

        {actions ? (
          <>
            <Separator />
            <div className="flex flex-wrap items-center gap-2">
              {actions}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

export default PluginCard
