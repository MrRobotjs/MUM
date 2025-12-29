import { useState, useEffect } from 'react'
import { IconDeviceFloppy, IconUsers, IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react'
import { requestJson } from '../util/apiClient'
import { useAlerts } from '../contexts'
import { PageHeader } from '../components'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'

type UserAccountSettings = {
  allow_user_accounts: boolean
}

const AdminSettingsUserGeneralPage = () => {
  const [settings, setSettings] = useState<UserAccountSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [allowUserAccounts, setAllowUserAccounts] = useState(false)
  const { success, error: showError } = useAlerts()

  useEffect(() => {
    fetchSettings()
  }, [])

  const fetchSettings = async () => {
    try {
      setLoading(true)
      const response = await requestJson<{ data: UserAccountSettings }>('/admin/api/v2/settings/user-accounts')
      setSettings(response.data)
      setAllowUserAccounts(response.data.allow_user_accounts)
    } catch (error) {
      showError(`Failed to load settings: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    try {
      setSaving(true)
      await requestJson('/admin/api/v2/settings/user-accounts', {
        method: 'PATCH',
        body: JSON.stringify({ allow_user_accounts: allowUserAccounts })
      })
      success('User account settings have been updated successfully')
      await fetchSettings()
    } catch (error) {
      showError(`Failed to save settings: ${error}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        Loading settings…
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users General Settings"
        description="Configure general user management settings and preferences"
      />

      {/* Under Development Notice */}
      <Alert variant="warning">
        <IconAlertTriangle />
        <AlertTitle>Under Development</AlertTitle>
        <AlertDescription>
          This page is currently under development. Some settings shown are placeholders and not yet functional, except for the User Accounts section which is fully operational.
        </AlertDescription>
      </Alert>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
                <IconUsers className="size-5 text-primary" />
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
              <IconInfoCircle />
              <AlertDescription>
                <strong>Note:</strong> User accounts are separate from media service accounts. Users will still need to be invited to media servers separately through the invitation system.
              </AlertDescription>
            </Alert>

            <div className="flex justify-end">
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? (
                  <span className="mr-2 inline-flex size-4 animate-spin rounded-full border-2 border-background border-t-transparent" />
                ) : (
                  <IconDeviceFloppy className="mr-2 size-4" />
                )}
                {saving ? 'Saving.' : 'Save User Account Settings'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-3">
          <Button size="sm" disabled>
            <IconDeviceFloppy className="mr-2 size-4" />
            Save Settings
          </Button>
        </div>
      </div>
    </div>
  )
}

export default AdminSettingsUserGeneralPage
