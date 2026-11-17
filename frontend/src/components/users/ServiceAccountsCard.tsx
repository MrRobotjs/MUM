import { Button } from '@/components/ui/button'
import type { ReactNode } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faServer } from '@fortawesome/free-solid-svg-icons'
import { getServiceMeta } from '@/config/pluginMetadata'
import { ServiceSettingIcon, SettingHeader, SettingIcon } from './AccountSettings'
import { Spinner } from '@/components/ui/spinner'

export type ServiceAccount = {
  uuid: string
  service_type?: string
  server_name?: string
  external_username?: string
  external_email?: string
  linked_at?: string
}

type ServiceAccountsCardProps = {
  accounts: ServiceAccount[]
  loading?: boolean
  error?: Error | null
  onUnlink?: (serviceUuid: string) => Promise<void> | void
  onLink?: () => void
  children?: ReactNode
  // Marks the account being viewed in the list.
  currentUuid?: string
  title?: string
  description?: string
}

export const ServiceAccountsCard = ({ accounts, loading, error, onUnlink, onLink, children, currentUuid, title = 'Linked service accounts', description = "Media server accounts owned by this person. Linking or unlinking changes which MUM profile owns the account; it doesn't change access on the server." }: ServiceAccountsCardProps) => (
  <Card>
    <SettingHeader
      title={title}
      icon={<SettingIcon className="bg-muted text-muted-foreground"><FontAwesomeIcon icon={faServer} /></SettingIcon>}
      summary={loading ? <Spinner className="size-4" /> : error ? 'Unavailable' : `${accounts.length} linked`}
      info={<p>{description}</p>}
      action={onLink ? <Button type="button" variant="outline" size="sm" onClick={onLink}>Link account</Button> : null}
    />
    {error || accounts.length > 0 || children ? (
      <CardContent className="space-y-3">
        {error ? <p className="text-sm text-destructive">Failed to load service accounts: {error.message}</p> : null}
        {!error && accounts.length > 0 ? (
          <ul className="divide-y rounded-md border">
            {accounts.map((account) => (
              <li key={account.uuid} className="flex items-center justify-between gap-3 p-3 text-sm">
                <div className="flex min-w-0 items-center gap-3">
                  <ServiceSettingIcon serviceType={account.service_type} />
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{account.external_username ?? 'Service Account'}{account.uuid === currentUuid ? <span className="text-xs font-normal text-muted-foreground"> · This account</span> : null}</p>
                    <p className="truncate text-xs text-muted-foreground">{getServiceMeta(account.service_type).label} • {account.server_name ?? 'Unknown server'}</p>
                  </div>
                </div>
                {onUnlink ? <Button type="button" variant="outline" size="sm" onClick={() => onUnlink(account.uuid)}>Unlink</Button> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {children}
      </CardContent>
    ) : null}
  </Card>
)

export default ServiceAccountsCard
