import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
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
}

export const ServiceAccountsCard = ({ accounts, loading, error, onUnlink, onLink }: ServiceAccountsCardProps) => {
  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading service accounts.
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          Failed to load service accounts: {error.message}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Linked Service Accounts</CardTitle>
          <CardDescription>{accounts.length} linked</CardDescription>
        </div>
        {onLink ? (
          <Button onClick={onLink} size="sm">
            Link Account
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No service accounts linked.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {accounts.map((account) => (
              <li key={account.uuid} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{account.external_username ?? 'Service Account'}</div>
                    <div className="text-xs text-muted-foreground">
                      {account.service_type ?? 'service'} • {account.server_name ?? 'Unknown server'}
                    </div>
                  </div>
                  {onUnlink ? (
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => onUnlink(account.uuid)}>
                      Unlink
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export default ServiceAccountsCard
