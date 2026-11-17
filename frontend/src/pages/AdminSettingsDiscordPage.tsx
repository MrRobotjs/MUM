import { useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faCircleExclamation,
  faTriangleExclamation,
  faCopy,
  faFloppyDisk,
  faCircleInfo,
  faKey,
  faRotate,
  faRobot,
  faFlask,
  faUsers,
} from '@fortawesome/free-solid-svg-icons'
import { faDiscord } from '@fortawesome/free-brands-svg-icons'
import { useDiscordSettings, type DiscordSettings } from '../hooks/useSettings'
import { PageHeader } from '../components'
import { requestJson } from '../util/apiClient'
import { useAlerts } from '../contexts'
import { discordRedirectHint, discordSettingsPayload, type DiscordSettingsValues } from '../lib/discordSignIn'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'

// Discord settings (DISCORD_SIGN_IN_DESIGN.md): the client ID and secret,
// the one redirect address to add in Discord, the optional Discord server
// (found from its invite link), defaults for new invites and Sign in with
// Discord. The bot is not available yet.

type DiscordFormMeta = {
  revision: number
  client_secret_set: boolean
  redirect_uri: string
  redirect_problem: string | null
  guild_id: string
  guild_name: string
  verified: boolean
}

type DiscordFormState = {
  values: DiscordSettingsValues
  meta: DiscordFormMeta
}

const buildDiscordFormState = (settings: DiscordSettings | null): DiscordFormState => ({
  values: {
    enable_oauth: settings?.enable_oauth ?? false,
    client_id: settings?.client_id ?? '',
    client_secret: '',
    server_invite_url: settings?.server_invite_url ?? '',
    guild_id: settings?.server_invite_url ? '' : settings?.guild_id ?? '',
    default_require_discord_auth: settings?.default_require_discord_auth ?? false,
    default_require_discord_guild_membership: settings?.default_require_discord_guild_membership ?? false,
    sign_in_enabled: settings?.sign_in_enabled ?? false,
    sign_in_admins: settings?.sign_in_admins ?? false,
  },
  meta: {
    revision: settings?.revision ?? 0,
    client_secret_set: settings?.client_secret_set ?? false,
    redirect_uri: settings?.redirect_uri_invite ?? '',
    redirect_problem: settings?.redirect_problem ?? null,
    guild_id: settings?.guild_id ?? '',
    guild_name: settings?.guild_name ?? '',
    verified: Boolean(settings?.verified_at),
  },
})

type DiscordSettingsFormProps = {
  initialState: DiscordFormState
  refresh: () => Promise<unknown>
}

const DiscordSettingsForm = ({ initialState, refresh }: DiscordSettingsFormProps) => {
  const { success, error: showError } = useAlerts()
  const [formValues, setFormValues] = useState<DiscordSettingsValues>(() => initialState.values)
  const formMeta = initialState.meta
  const [submitting, setSubmitting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)

  const handleChange = (field: 'client_id' | 'client_secret' | 'server_invite_url' | 'guild_id', value: string) => {
    setFormValues((prev) => ({ ...prev, [field]: value }))
    setHasChanges(true)
  }

  const handleToggle = (
    field: 'enable_oauth' | 'default_require_discord_auth' | 'default_require_discord_guild_membership' | 'sign_in_enabled' | 'sign_in_admins',
    value: boolean
  ) => {
    setFormValues((prev) => {
      const next = { ...prev, [field]: value }
      if (field === 'default_require_discord_guild_membership' && value) next.default_require_discord_auth = true
      if (field === 'default_require_discord_auth' && !value) next.default_require_discord_guild_membership = false
      if (field === 'sign_in_enabled' && !value) next.sign_in_admins = false
      return next
    })
    setHasChanges(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      await requestJson('/api/settings/discord', {
        method: 'PATCH',
        body: JSON.stringify(discordSettingsPayload(formValues, formMeta.revision)),
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
        '/api/settings/discord/test',
        { method: 'POST', body: JSON.stringify({ type: 'oauth' }) }
      )
      if (response.data?.success) {
        success(response.data.message || 'Discord connection test successful')
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
    setFormValues(initialState.values)
    setHasChanges(false)
  }

  const handleCopy = async (label: string, value: string) => {
    if (!value) {
      showError(`Nothing to copy for ${label}.`)
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      success(`${label} copied to clipboard.`)
    } catch (err) {
      showError(`Failed to copy ${label}: ${(err as Error).message}`)
    }
  }

  const clientSecretConfigured = formMeta.client_secret_set || formValues.client_secret.length > 0
  const requireClientSecret = formValues.enable_oauth && !formMeta.client_secret_set
  const oauthDisabled = !formValues.enable_oauth
  const redirectHint = discordRedirectHint(formMeta.redirect_problem)
  const serverKnown = formValues.server_invite_url.trim() !== '' || formValues.guild_id.trim() !== ''
  const checklist: { done: boolean; text: string }[] = [
    { done: formMeta.redirect_problem === null && formMeta.redirect_uri !== '', text: formMeta.redirect_uri ? 'Redirect URL ready to add in Discord' : 'Redirect URL needs an App Base URL' },
    { done: formMeta.verified, text: formMeta.verified ? 'Client ID and secret checked by Discord' : 'Client ID and secret not checked yet (turn on Discord and save)' },
    { done: formMeta.guild_id !== '', text: formMeta.guild_id ? `Discord server: ${formMeta.guild_name || formMeta.guild_id}` : 'No Discord server yet (only needed to require server membership)' },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Discord Settings"
        description="Configure Discord OAuth and bot integration"
      />

      <Alert variant="info">
        <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
        <AlertTitle>Discord Integration Setup</AlertTitle>
        <AlertDescription>
          <p>1. Create an application in the{' '}
          <a
            href="https://discord.com/developers/applications"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-4 hover:text-blue-600 dark:text-blue-400"
          >
            Discord Developer Portal
          </a>.</p>
          <p>2. Under OAuth2, copy the Client ID and Client Secret into the fields below, and add the Redirect URL shown below to Redirects.</p>
          <p>3. Turn on Discord and save: MUM checks the ID and secret with Discord first.</p>
        </AlertDescription>
      </Alert>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className='gap-4'>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
                  <FontAwesomeIcon icon={faDiscord} className="size-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="mb-1 text-xl font-semibold">Discord OAuth</CardTitle>
                  <CardDescription>Discord sign-in on invites, linking Discord accounts and Sign in with Discord.</CardDescription>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-border/70 bg-background p-3 space-y-2">
              {checklist.map((item) => (
                <p key={item.text} className="text-sm flex items-center gap-2">
                  <FontAwesomeIcon icon={item.done ? faCircleInfo : faCircleExclamation} className={item.done ? 'size-4 text-primary' : 'size-4 text-warning'} />
                  {item.text}
                </p>
              ))}
            </div>

            <div className="rounded-lg border border-border/70 bg-muted/40 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/20">
                    <FontAwesomeIcon icon={faKey} className="size-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Turn On Discord</p>
                    <p className="text-xs text-muted-foreground">
                      Needed for Discord on invites, linking and Sign in with Discord. Saving with this on checks the ID and secret with Discord.
                    </p>
                  </div>
                </div>
                <Switch
                  id="discord-enabled"
                  checked={formValues.enable_oauth}
                  onCheckedChange={(checked) => handleToggle('enable_oauth', checked)}
                />
              </div>
              <div className="rounded-lg border border-border/70 bg-background p-3 space-y-4">

                <div className="space-y-2">
                  <Label htmlFor="client_id">
                    Client ID {formValues.enable_oauth && <span className="text-destructive">*</span>}
                  </Label>
                  <Input
                    id="client_id"
                    type="text"
                    className="font-mono"
                    value={formValues.client_id}
                    onChange={(e) => handleChange('client_id', e.target.value)}
                    required={formValues.enable_oauth}
                    placeholder="1234567890123456789"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="client_secret">
                    Client Secret {requireClientSecret && <span className="text-destructive">*</span>}
                  </Label>
                  <Input
                    id="client_secret"
                    type="password"
                    className="font-mono"
                    value={formValues.client_secret}
                    onChange={(e) => handleChange('client_secret', e.target.value)}
                    required={requireClientSecret}
                    placeholder="********"
                  />
                  <p className="text-xs text-muted-foreground">
                    {clientSecretConfigured ? 'Secret is already configured. Leave blank to keep it.' : 'Enter your client secret.'}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="redirect_uri">Redirect URL</Label>
                  <div className="relative">
                    <Input
                      id="redirect_uri"
                      type="url"
                      className="pr-10 font-mono"
                      value={formMeta.redirect_uri}
                      readOnly
                      disabled
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-2 top-1/2 h-7 w-7 -translate-y-1/2"
                      onClick={() => handleCopy('Redirect URL', formMeta.redirect_uri)}
                      disabled={!formMeta.redirect_uri}
                      aria-label="Copy redirect URL"
                    >
                      <FontAwesomeIcon icon={faCopy} className="size-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Add this address to Redirects under OAuth2 in the Discord Developer Portal. It serves invites, linking and Sign in with Discord.
                  </p>
                  {redirectHint && <p className="text-xs text-warning">{redirectHint}</p>}
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border/70 bg-muted/40 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/20">
                  <FontAwesomeIcon icon={faUsers} className="size-4 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-medium">Discord Server (optional)</p>
                  <p className="text-xs text-muted-foreground">
                    Only needed to require server membership on invites. Paste an invite link to your server; MUM finds the server from it.
                  </p>
                </div>
              </div>

              <div className="rounded-lg border border-border/70 bg-background p-3 space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="server_invite_url">Server Invite Link</Label>
                  <Input
                    id="server_invite_url"
                    type="url"
                    className="font-mono"
                    value={formValues.server_invite_url}
                    onChange={(e) => handleChange('server_invite_url', e.target.value)}
                    placeholder="https://discord.gg/your-invite"
                  />
                  <p className="text-xs text-muted-foreground">
                    Invitees use this link to join your server, so it must keep working: in Discord, choose Invite People, then Edit invite link, and set Expire After to Never and Max Number of Uses to No limit. MUM refuses a link that expires.
                  </p>
                  {formMeta.guild_id && formValues.server_invite_url === initialState.values.server_invite_url && formValues.server_invite_url !== '' && (
                    <p className="text-xs text-muted-foreground">Server: {formMeta.guild_name || 'Unnamed server'} (ID {formMeta.guild_id})</p>
                  )}
                </div>

                {formValues.server_invite_url.trim() === '' && (
                  <div className="space-y-2">
                    <Label htmlFor="guild_id">Server ID (only without an invite link)</Label>
                    <Input
                      id="guild_id"
                      type="text"
                      className="font-mono"
                      value={formValues.guild_id}
                      onChange={(e) => handleChange('guild_id', e.target.value)}
                      placeholder="1234567890123456789"
                    />
                    <p className="text-xs text-muted-foreground">
                      Enable Developer Mode in Discord, right-click your server, and select "Copy ID"
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-border/70 bg-muted/40 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">New Invites Require Discord Sign-In</p>
                  <p className="text-xs text-muted-foreground">Pre-ticks the option on new invites; you can still change it on each invite.</p>
                </div>
                <Switch
                  checked={formValues.default_require_discord_auth}
                  onCheckedChange={(checked) => handleToggle('default_require_discord_auth', checked)}
                  disabled={oauthDisabled}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">New Invites Require Server Membership</p>
                  <p className="text-xs text-muted-foreground">{serverKnown ? 'Invitees must be in your Discord server. Pre-ticks the option on new invites.' : 'Add your server\'s invite link above first.'}</p>
                </div>
                <Switch
                  checked={formValues.default_require_discord_guild_membership}
                  onCheckedChange={(checked) => handleToggle('default_require_discord_guild_membership', checked)}
                  disabled={oauthDisabled || !serverKnown}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Allow Sign in with Discord</p>
                  <p className="text-xs text-muted-foreground">People who linked Discord on their account page can sign in with it. A Discord account never creates a MUM account, and the owner always uses the MUM password.</p>
                </div>
                <Switch
                  checked={formValues.sign_in_enabled}
                  onCheckedChange={(checked) => handleToggle('sign_in_enabled', checked)}
                  disabled={oauthDisabled}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Include Accounts with Admin Access</p>
                  <p className="text-xs text-muted-foreground">Off (recommended): administrators sign in with their MUM password. On: anyone who controls an administrator's Discord account can sign in as that administrator.</p>
                </div>
                <Switch
                  checked={formValues.sign_in_admins}
                  onCheckedChange={(checked) => handleToggle('sign_in_admins', checked)}
                  disabled={oauthDisabled || !formValues.sign_in_enabled}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
                  <FontAwesomeIcon icon={faRobot} className="size-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="mb-1 text-xl font-semibold">Bot Configuration</CardTitle>
                  <CardDescription>Optional bot automation and moderation tools.</CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Label htmlFor="bot-enabled" className="cursor-pointer">
                  Enable Bot
                </Label>
                <Switch id="bot-enabled" checked={false} disabled />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="warning">
              <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
              <AlertTitle>Not Available Yet</AlertTitle>
              <AlertDescription>
                The Discord bot is not available in this version, so its settings cannot be turned on.
              </AlertDescription>
            </Alert>
            <div className="space-y-2">
              <Label htmlFor="bot_token">Bot Token</Label>
              <Input id="bot_token" type="password" className="font-mono" value="" disabled placeholder="********" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="monitored_role_id">Monitored Role ID</Label>
              <Input id="monitored_role_id" type="text" className="font-mono" value="" disabled placeholder="1234567890123456789" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="thread_channel_id">Thread Channel ID</Label>
              <Input id="thread_channel_id" type="text" className="font-mono" value="" disabled placeholder="1234567890123456789" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bot_log_channel_id">Bot Log Channel ID</Label>
              <Input id="bot_log_channel_id" type="text" className="font-mono" value="" disabled placeholder="1234567890123456789" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/40 p-3">
              <div>
                <p className="text-sm font-medium">Whitelist Sharers</p>
                <p className="text-xs text-muted-foreground">
                  Automatically whitelist users who share back.
                </p>
              </div>
              <Switch checked={false} disabled />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => void handleTest()}
            disabled={testing || !formMeta.client_secret_set || !formValues.client_id}
          >
            {testing ? (
              <>
                <Spinner className="mr-2 size-4 text-muted-foreground" />
                Testing...
              </>
            ) : (
              <>
                <FontAwesomeIcon icon={faFlask} className="mr-2 size-4" />
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
            <FontAwesomeIcon icon={faRotate} className="mr-2 size-4" />
            Reset
          </Button>
          <Button type="submit" disabled={!hasChanges || submitting}>
            {submitting ? (
              <>
                <Spinner className="mr-2 size-4 text-background" />
                Saving...
              </>
            ) : (
              <>
                <FontAwesomeIcon icon={faFloppyDisk} className="mr-2 size-4" />
                Save Changes
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}

const AdminSettingsDiscordPage = () => {
  const { settings, loading, error, refresh } = useDiscordSettings()

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4 text-muted-foreground" />
        Loading Discord settings...
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>
          Failed to load Discord settings: {(error as Error).message}
        </AlertDescription>
      </Alert>
    )
  }

  const settingsKey = settings ? JSON.stringify(settings) : 'empty'
  const initialState = buildDiscordFormState(settings)

  return <DiscordSettingsForm key={settingsKey} initialState={initialState} refresh={refresh} />
}

export default AdminSettingsDiscordPage
