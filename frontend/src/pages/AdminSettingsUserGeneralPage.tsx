import { useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faFloppyDisk, faUsers, faTriangleExclamation, faCircleInfo } from '@fortawesome/free-solid-svg-icons'
import { requestJson } from '../util/apiClient'
import { useAlerts } from '../contexts'
import { PageHeader } from '../components'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useUserAccountSettings } from '../hooks/useSettings'
import { Spinner } from '@/components/ui/spinner'

type UserAccountSettingsFormProps = {
  initialValue: boolean
  refresh: () => Promise<unknown>
}

const UserAccountSettingsForm = ({ initialValue, refresh }: UserAccountSettingsFormProps) => {
  const [saving, setSaving] = useState(false)
  const [allowUserAccounts, setAllowUserAccounts] = useState(initialValue)
  const { success, error: showError } = useAlerts()

  const handleSave = async () => {
    try {
      setSaving(true)
      await requestJson('/admin/api/v2/settings/user-accounts', {
        method: 'PATCH',
        body: JSON.stringify({ allow_user_accounts: allowUserAccounts })
      })
      success('User account settings have been updated successfully')
      await refresh()
    } catch (error) {
      showError(`Failed to save settings: ${error}`)
    } finally {
      setSaving(false)
    }
  }


  return (
    <div className="space-y-6">
      <PageHeader
        title="Users General Settings"
        description="Configure general user management settings and preferences"
      />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
                <FontAwesomeIcon icon={faUsers} className="size-5 text-primary" />
              </div>
              <div>
                <CardTitle className="mb-1 text-xl font-semibold">User Accounts</CardTitle>
                <CardDescription>Control whether users can create and manage their own accounts.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border p-4 transition-colors hover:border-primary/30">
              <div className="flex-1 pr-4">
                <Label htmlFor="allow-user-accounts" className="cursor-pointer text-base font-medium">
                  Allow User Account Creation
                </Label>
                <p className="mt-1 text-sm text-muted-foreground">
                  When enabled, users can create their own accounts without admin approval. When disabled, only administrators can create user accounts.
                </p>
              </div>
              <Switch
                id="allow-user-accounts"
                checked={allowUserAccounts}
                onCheckedChange={setAllowUserAccounts}
              />
            </div>

            <Alert variant="info">
              <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
              <AlertDescription>
                <strong>Note:</strong> User accounts are separate from media service accounts. Users will still need to be invited to media servers separately through the invitation system.
              </AlertDescription>
            </Alert>

            <div className="flex justify-end">
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? (
                  <Spinner className="mr-2 size-4 text-background" />
                ) : (
                  <FontAwesomeIcon icon={faFloppyDisk} className="mr-2 size-4" />
                )}
                {saving ? 'Saving.' : 'Save User Account Settings'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-3">
          <Button size="sm" disabled>
            <FontAwesomeIcon icon={faFloppyDisk} className="mr-2 size-4" />
            Save Settings
          </Button>
        </div>
      </div>
    </div>
  )
}

const AdminSettingsUserGeneralPage = () => {
  const { settings, loading, error, refresh } = useUserAccountSettings()

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4 text-muted-foreground" />
        Loading settings.
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
        <AlertTitle>Failed to load settings</AlertTitle>
        <AlertDescription>{(error as Error).message}</AlertDescription>
      </Alert>
    )
  }

  const settingsKey = settings ? String(settings.allow_user_accounts) : 'empty'

  return (
    <UserAccountSettingsForm
      key={settingsKey}
      initialValue={settings?.allow_user_accounts ?? false}
      refresh={refresh}
    />
  )
}

export default AdminSettingsUserGeneralPage
