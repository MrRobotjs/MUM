import { useState, useEffect } from 'react'
import { IconDeviceFloppy, IconRefresh, IconTestPipe } from '@tabler/icons-react'
import { useDiscordSettings, type DiscordSettings } from '../hooks/useSettings'
import { PageHeader } from '../components'
import { requestJson } from '../util/apiClient'
import { useAlerts } from '../contexts'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'

export const DiscordSettingsPage = () => {
  const { settings, loading, error, refresh } = useDiscordSettings()
  const { success, error: showError } = useAlerts()
  const [formValues, setFormValues] = useState<DiscordSettings>({
    enabled: false,
    client_id: '',
    client_secret: '',
    bot_token: '',
    guild_id: '',
    redirect_uri: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    if (settings) {
      setFormValues(settings)
      setHasChanges(false)
    }
  }, [settings])

  const handleChange = (field: keyof DiscordSettings, value: string | boolean) => {
    setFormValues((prev) => ({ ...prev, [field]: value }))
    setHasChanges(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      await requestJson('/admin/api/v1/settings/discord', {
        method: 'PATCH',
        body: JSON.stringify(formValues),
      })
      success('Discord settings saved successfully')
      setHasChanges(false)
      await refresh()
    } catch (err) {
      showError(`Failed to save settings: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const response = await requestJson<{ data: { success: boolean; message?: string } }>(
        '/admin/api/v1/settings/discord/test',
        { method: 'POST' }
      )
      if (response.data?.success) {
        success('Discord connection test successful')
      } else {
        showError(`Discord test failed: ${response.data?.message || 'Unknown error'}`)
      }
    } catch (err) {
      showError(`Discord test failed: ${(err as Error).message}`)
    } finally {
      setTesting(false)
    }
  }

  const handleReset = () => {
    if (settings) {
      setFormValues(settings)
      setHasChanges(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        Loading Discord settings...
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>
          Failed to load Discord settings: {(error as Error).message}
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Discord Settings"
        description="Configure Discord OAuth and bot integration"
      />

      <Alert variant="info">
        <div className="flex items-start gap-3">
          <i className="fa-brands fa-discord text-2xl text-info"></i>
          <div>
            <AlertTitle>Discord Integration Setup</AlertTitle>
            <AlertDescription>
              Create a Discord application at{' '}
              <a
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline underline-offset-4 hover:text-info"
              >
                Discord Developer Portal
              </a>{' '}
              to get your Client ID and Secret.
            </AlertDescription>
          </div>
        </div>
      </Alert>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Discord Integration</CardTitle>
              <div className="flex items-center gap-3">
                <Label htmlFor="discord-enabled" className="cursor-pointer">
                  Enable Discord
                </Label>
                <Switch
                  id="discord-enabled"
                  checked={formValues.enabled}
                  onCheckedChange={(checked) => handleChange('enabled', checked)}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="client_id">
                Client ID {formValues.enabled && <span className="text-destructive">*</span>}
              </Label>
              <Input
                id="client_id"
                type="text"
                className="font-mono"
                value={formValues.client_id}
                onChange={(e) => handleChange('client_id', e.target.value)}
                required={formValues.enabled}
                placeholder="1234567890123456789"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="client_secret">Client Secret</Label>
              <Input
                id="client_secret"
                type="password"
                className="font-mono"
                value={formValues.client_secret}
                onChange={(e) => handleChange('client_secret', e.target.value)}
                placeholder="••••••••••••••••••••••••••••••"
              />
              <p className="text-xs text-muted-foreground">
                Leave blank to keep existing secret
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="guild_id">
                Guild (Server) ID {formValues.enabled && <span className="text-destructive">*</span>}
              </Label>
              <Input
                id="guild_id"
                type="text"
                className="font-mono"
                value={formValues.guild_id}
                onChange={(e) => handleChange('guild_id', e.target.value)}
                required={formValues.enabled}
                placeholder="1234567890123456789"
              />
              <p className="text-xs text-muted-foreground">
                Enable Developer Mode in Discord, right-click your server, and select "Copy ID"
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="redirect_uri">
                Redirect URI {formValues.enabled && <span className="text-destructive">*</span>}
              </Label>
              <Input
                id="redirect_uri"
                type="url"
                className="font-mono"
                value={formValues.redirect_uri}
                onChange={(e) => handleChange('redirect_uri', e.target.value)}
                required={formValues.enabled}
                placeholder="https://mum.example.com/auth/discord/callback"
              />
              <p className="text-xs text-muted-foreground">
                Add this URL to your Discord application's OAuth2 redirect URIs
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Bot Configuration (Optional)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="bot_token">Bot Token</Label>
              <Input
                id="bot_token"
                type="password"
                className="font-mono"
                value={formValues.bot_token}
                onChange={(e) => handleChange('bot_token', e.target.value)}
                placeholder="••••••••••••••••••••••••••••••"
              />
              <p className="text-xs text-muted-foreground">
                Bot token for advanced Discord features (role assignment, announcements)
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-3">
          <Button
            type="button"
            variant="ghost"
            onClick={handleTest}
            disabled={testing || !formValues.enabled}
          >
            {testing ? (
              <>
                <span className="mr-2 inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                Testing...
              </>
            ) : (
              <>
                <IconTestPipe className="mr-2 size-4" />
                Test Connection
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleReset}
            disabled={!hasChanges || submitting}
          >
            <IconRefresh className="mr-2 size-4" />
            Reset
          </Button>
          <Button type="submit" disabled={!hasChanges || submitting}>
            {submitting ? (
              <>
                <span className="mr-2 inline-flex size-4 animate-spin rounded-full border-2 border-background border-t-transparent" />
                Saving...
              </>
            ) : (
              <>
                <IconDeviceFloppy className="mr-2 size-4" />
                Save Changes
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}

export default DiscordSettingsPage
