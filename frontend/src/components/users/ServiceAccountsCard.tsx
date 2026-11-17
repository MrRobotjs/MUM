import { Button } from '@/components/ui/button'
import type { ReactNode } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { SettingHeader } from './AccountSettings'
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
}

export const ServiceAccountsCard = ({ accounts, loading, error, onUnlink, onLink, children }: ServiceAccountsCardProps) => (
  <Card>
    <SettingHeader
      title="Linked service accounts"
      summary={loading ? <Spinner className="size-4" /> : error ? 'Unavailable' : `${accounts.length} linked`}
      info={<p>Media server accounts owned by this person. Linking or unlinking changes which MUM profile owns the account; it doesn't change access on the server.</p>}
      action={onLink ? <Button type="button" variant="outline" size="sm" onClick={onLink}>Link account</Button> : null}
    />
    {error || accounts.length > 0 || children ? (
      <CardContent className="space-y-3">
        {error ? <p className="text-sm text-destructive">Failed to load service accounts: {error.message}</p> : null}
        {!error && accounts.length > 0 ? (
          <ul className="divide-y rounded-md border">
            {accounts.map((account) => (
              <li key={account.uuid} className="flex items-center justify-between gap-3 p-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{account.external_username ?? 'Service Account'}</p>
                  <p className="truncate text-xs text-muted-foreground">{account.service_type ?? 'service'} • {account.server_name ?? 'Unknown server'}</p>
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
