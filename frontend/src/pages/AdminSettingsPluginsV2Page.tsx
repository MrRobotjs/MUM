import { useMemo } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleExclamation, faCircleInfo } from '@fortawesome/free-solid-svg-icons'

import { PageHeader } from '../components'
import { usePlugins } from '../hooks/usePlugins'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const TableSkeleton = () => (
  <div className="space-y-3">
    <Skeleton className="h-10 w-full" />
    <Skeleton className="h-10 w-full" />
    <Skeleton className="h-10 w-full" />
    <Skeleton className="h-10 w-full" />
  </div>
)

export const AdminSettingsPluginsV2Page = () => {
  const { plugins, loading, error } = usePlugins()

  const sortedPlugins = useMemo(() => {
    return [...plugins].sort((a, b) => a.name.localeCompare(b.name))
  }, [plugins])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plugins V2"
        description="Migration view for manifest-driven media provider plugins."
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
          <AlertTitle>Migration Mode</AlertTitle>
          <AlertDescription>
            This page is read-only and intended to validate the plugin migration to V2 manifests.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <TableSkeleton />
          ) : sortedPlugins.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No plugins found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plugin</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Servers</TableHead>
                  <TableHead>Capabilities</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedPlugins.map((plugin) => (
                  <TableRow key={plugin.pluginId}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{plugin.name}</span>
                        <span className="text-xs text-muted-foreground">{plugin.pluginId}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{(plugin.pluginType ?? 'unknown').toUpperCase()}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={plugin.enabled ? 'default' : 'secondary'}>
                        {plugin.enabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </TableCell>
                    <TableCell>{plugin.serversCount}</TableCell>
                    <TableCell>
                      {plugin.capabilities.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {plugin.capabilities.slice(0, 6).map((capability) => (
                            <Badge key={`${plugin.pluginId}-${capability}`} variant="outline" className="text-[11px]">
                              {capability}
                            </Badge>
                          ))}
                          {plugin.capabilities.length > 6 ? (
                            <Badge variant="outline" className="text-[11px]">
                              +{plugin.capabilities.length - 6}
                            </Badge>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">None</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default AdminSettingsPluginsV2Page
