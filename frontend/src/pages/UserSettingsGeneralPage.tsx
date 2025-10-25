import { useState, useEffect } from 'react'
import { IconDeviceFloppy, IconUsers, IconShield, IconAdjustments, IconAlertTriangle, IconAlertCircle, IconInfoCircle } from '@tabler/icons-react'
import { requestJson } from '../util/apiClient'
import { useAlerts } from '../contexts'
import { PageHeader } from '../components'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type UserAccountSettings = {
  allow_user_accounts: boolean
}

const UserSettingsGeneralPage = () => {
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
      const response = await requestJson<{ data: UserAccountSettings }>('/admin/api/v1/settings/user-accounts')
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
      await requestJson('/admin/api/v1/settings/user-accounts', {
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

      {/* General Settings Overview */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <IconUsers className="size-5 text-primary" />
            </div>
            <div>
              <h2 className="mb-1 text-xl font-semibold">User Management</h2>
              <p className="text-sm text-muted-foreground">General configuration for user accounts and settings</p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Alert variant="info">
            <IconInfoCircle />
            <AlertTitle>User Settings</AlertTitle>
            <AlertDescription>
              Configure general user management settings including default permissions, account policies, and user preferences.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Settings Form Section */}
      <Card>
        <CardContent>
          <div className="mb-6 flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-full bg-secondary/20">
              <i className="fa-solid fa-cog text-sm text-secondary" />
            </div>
            <h3 className="text-lg font-semibold">Configuration Settings</h3>
          </div>

          <div className="space-y-6">
            {/* User Accounts Feature Section */}
            <div className="space-y-4 rounded-lg border bg-card p-4">
              <h4 className="flex items-center gap-2 font-medium">
                <i className="fa-solid fa-user-plus text-sm text-primary" />
                User Accounts
              </h4>
              <p className="text-sm text-muted-foreground">
                Control whether users can create and manage their own accounts.
              </p>

              <div className="space-y-4">
                {/* Allow User Accounts Toggle */}
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

                {/* Additional Info */}
                <Alert variant="info">
                  <IconInfoCircle />
                  <AlertDescription>
                    <strong>Note:</strong> User accounts are separate from media service accounts. Users will still need to be invited to media servers separately through the invitation system.
                  </AlertDescription>
                </Alert>

                {/* Save Button */}
                <div className="flex justify-end">
                  <Button size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? (
                      <span className="mr-2 inline-flex size-4 animate-spin rounded-full border-2 border-background border-t-transparent" />
                    ) : (
                      <IconDeviceFloppy className="mr-2 size-4" />
                    )}
                    {saving ? 'Saving…' : 'Save User Account Settings'}
                  </Button>
                </div>
              </div>
            </div>

            {/* Account Policies Section */}
            <div className="space-y-4 rounded-lg border bg-card p-4">
              <h4 className="flex items-center gap-2 font-medium">
                <IconShield className="size-4 text-primary" />
                Account Policies
              </h4>
              <p className="text-sm text-muted-foreground">
                Configure account security and behavior policies.
              </p>

              <div className="space-y-4">
                {/* Password Requirements */}
                <div className="space-y-2">
                  <Label htmlFor="min-password" className="text-sm font-medium">
                    Minimum Password Length
                  </Label>
                  <Input
                    id="min-password"
                    type="number"
                    className="w-24"
                    defaultValue={8}
                    min={6}
                    max={50}
                    disabled
                  />
                </div>

                {/* Session Timeout */}
                <div className="space-y-2">
                  <Label htmlFor="session-timeout" className="text-sm font-medium">
                    Session Timeout (hours)
                  </Label>
                  <Input
                    id="session-timeout"
                    type="number"
                    className="w-24"
                    defaultValue={24}
                    min={1}
                    max={168}
                    disabled
                  />
                </div>

                {/* Account Expiration */}
                <div className="space-y-2">
                  <Label htmlFor="account-expiration" className="text-sm font-medium">
                    Default Account Expiration (days)
                  </Label>
                  <Input
                    id="account-expiration"
                    type="number"
                    className="w-24"
                    defaultValue={365}
                    min={1}
                    max={3650}
                    disabled
                  />
                  <p className="text-xs text-muted-foreground">Set to 0 for no expiration</p>
                </div>
              </div>
            </div>

            {/* User Preferences Section */}
            <div className="space-y-4 rounded-lg border bg-card p-4">
              <h4 className="flex items-center gap-2 font-medium">
                <IconAdjustments className="size-4 text-primary" />
                Default User Preferences
              </h4>
              <p className="text-sm text-muted-foreground">
                Set default preferences for new user accounts.
              </p>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {/* Default Theme */}
                <div className="space-y-2">
                  <Label htmlFor="default-theme" className="text-sm font-medium">
                    Default Theme
                  </Label>
                  <Select disabled>
                    <SelectTrigger id="default-theme">
                      <SelectValue placeholder="Auto (System)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto (System)</SelectItem>
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="dark">Dark</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Default Language */}
                <div className="space-y-2">
                  <Label htmlFor="default-language" className="text-sm font-medium">
                    Default Language
                  </Label>
                  <Select disabled>
                    <SelectTrigger id="default-language">
                      <SelectValue placeholder="English" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="es">Spanish</SelectItem>
                      <SelectItem value="fr">French</SelectItem>
                      <SelectItem value="de">German</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </div>

          {/* Save Button (disabled for now) */}
          <div className="mt-6 flex items-center justify-end gap-3 border-t pt-6">
            <Button size="sm" disabled>
              <IconDeviceFloppy className="mr-2 size-4" />
              Save Settings
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default UserSettingsGeneralPage
