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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'

type DiscordFormValues = {
  enable_oauth: boolean
  enable_bot: boolean
  enable_membership_requirement: boolean
  default_require_discord_auth: boolean
  default_require_discord_guild_membership: boolean
  client_id: string
  client_secret: string
  oauth_auth_url: string
  guild_id: string
  server_invite_url: string
  bot_token: string
  monitored_role_id: string
  thread_channel_id: string
  bot_log_channel_id: string
  whitelist_sharers: boolean
}

type DiscordFormMeta = {
  client_secret_set: boolean
  bot_token_set: boolean
  redirect_uri_invite: string
  redirect_uri_admin: string
}

const emptyFormValues: DiscordFormValues = {
  enable_oauth: false,
  enable_bot: false,
  enable_membership_requirement: false,
  default_require_discord_auth: false,
  default_require_discord_guild_membership: false,
  client_id: '',
  client_secret: '',
  oauth_auth_url: '',
  guild_id: '',
  server_invite_url: '',
  bot_token: '',
  monitored_role_id: '',
  thread_channel_id: '',
  bot_log_channel_id: '',
  whitelist_sharers: false,
}

const emptyFormMeta: DiscordFormMeta = {
  client_secret_set: false,
  bot_token_set: false,
  redirect_uri_invite: '',
  redirect_uri_admin: '',
}

type DiscordFormState = {
  values: DiscordFormValues
  meta: DiscordFormMeta
  useOauthOverride: boolean
}

const buildDiscordFormState = (settings: DiscordSettings | null): DiscordFormState => {
  if (!settings) {
    return {
      values: emptyFormValues,
      meta: emptyFormMeta,
      useOauthOverride: false,
    }
  }

  const defaultRequireGuild = settings.default_require_discord_guild_membership
  const defaultRequireAuth = settings.default_require_discord_auth || defaultRequireGuild

  return {
    values: {
      enable_oauth: settings.enable_oauth,
      enable_bot: settings.enable_bot,
      enable_membership_requirement: settings.enable_membership_requirement,
      default_require_discord_auth: defaultRequireAuth,
      default_require_discord_guild_membership: defaultRequireGuild,
      client_id: settings.client_id ?? '',
      client_secret: '',
      oauth_auth_url: settings.oauth_auth_url ?? '',
      guild_id: settings.guild_id ?? '',
      server_invite_url: settings.server_invite_url ?? '',
      bot_token: '',
      monitored_role_id: settings.monitored_role_id ?? '',
      thread_channel_id: settings.thread_channel_id ?? '',
      bot_log_channel_id: settings.bot_log_channel_id ?? '',
      whitelist_sharers: settings.whitelist_sharers,
    },
    meta: {
      client_secret_set: settings.client_secret_set,
      bot_token_set: settings.bot_token_set,
      redirect_uri_invite: settings.redirect_uri_invite ?? '',
      redirect_uri_admin: settings.redirect_uri_admin ?? '',
    },
    useOauthOverride: Boolean(settings.oauth_auth_url),
  }
}

type DiscordSettingsFormProps = {
  initialState: DiscordFormState
  refresh: () => Promise<unknown>
}

const DiscordSettingsForm = ({ initialState, refresh }: DiscordSettingsFormProps) => {
  const { success, error: showError } = useAlerts()
  const [formValues, setFormValues] = useState<DiscordFormValues>(() => initialState.values)
  const formMeta = initialState.meta
  const [submitting, setSubmitting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)
  const [useOauthOverride, setUseOauthOverride] = useState(() => initialState.useOauthOverride)

  const handleChange = (field: keyof DiscordFormValues, value: string) => {
    setFormValues((prev) => ({ ...prev, [field]: value }))
    setHasChanges(true)
  }

  const handleToggle = (
    field: 'enable_oauth' | 'enable_bot' | 'enable_membership_requirement' | 'whitelist_sharers' | 'default_require_discord_auth' | 'default_require_discord_guild_membership',
    value: boolean
  ) => {
    setFormValues((prev) => {
      const next = { ...prev, [field]: value }
      if (field === 'enable_oauth' && !value) {
        next.enable_bot = false
        next.enable_membership_requirement = false
        next.default_require_discord_auth = false
        next.default_require_discord_guild_membership = false
        return next
      }
      if (field === 'default_require_discord_guild_membership' && value) {
        next.default_require_discord_auth = true
      }
      if (field === 'default_require_discord_auth' && !value) {
        next.default_require_discord_guild_membership = false
        next.enable_membership_requirement = false
      }
      if (
        (next.enable_bot || next.enable_membership_requirement || next.default_require_discord_auth || next.default_require_discord_guild_membership)
        && !next.enable_oauth
      ) {
        next.enable_oauth = true
      }
      return next
    })
    setHasChanges(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      await requestJson('/admin/api/v2/settings/discord', {
        method: 'PATCH',
        body: JSON.stringify({
          ...formValues,
          redirect_uri_invite: formMeta.redirect_uri_invite,
          redirect_uri_admin: formMeta.redirect_uri_admin,
        }),
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

  const handleTest = async (type: 'oauth' | 'bot' = 'oauth') => {
    setTesting(true)
    try {
      const response = await requestJson<{ data: { success: boolean; message?: string } }>(
        '/admin/api/v2/settings/discord/test',
        { method: 'POST', body: JSON.stringify({ type }) }
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
    setFormValues(initialState.values)
    setUseOauthOverride(initialState.useOauthOverride)
    setHasChanges(false)
  }

  const requireGuildId = formValues.enable_bot || formValues.enable_membership_requirement || formValues.default_require_discord_guild_membership
  const clientSecretConfigured = formMeta.client_secret_set || formValues.client_secret.length > 0
  const requireClientSecret = formValues.enable_oauth && !formMeta.client_secret_set
  const oauthDisabled = !formValues.enable_oauth
  const requireMembershipInviteUrl = formValues.enable_membership_requirement || formValues.default_require_discord_guild_membership
  const generatedOauthUrl = (() => {
    if (!formValues.client_id || !formMeta.redirect_uri_invite) {
      return ''
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: formValues.client_id,
      scope: 'identify email guilds',
      state: '{STATE}',
      redirect_uri: formMeta.redirect_uri_invite,
      prompt: 'consent',
    })
    const query = params.toString().replace(/state=%7BSTATE%7D/i, 'state={STATE}')
    return `https://discord.com/api/v10/oauth2/authorize?${query}`
  })()
  const oauthAuthInputValue = useOauthOverride ? formValues.oauth_auth_url : generatedOauthUrl

  const handleOauthOverrideToggle = (value: boolean) => {
    setUseOauthOverride(value)
    setFormValues((prev) => ({
      ...prev,
      oauth_auth_url: value ? (prev.oauth_auth_url || generatedOauthUrl) : ''
    }))
    setHasChanges(true)
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
          <p>Create a Discord application at{' '}
          <a
            href="https://discord.com/developers/applications"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-4 hover:text-blue-600 dark:text-blue-400"
          >
            Discord Developer Portal
          </a>{' '}
          to get your Client ID and Secret.</p>
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
                  <CardDescription>Connect MUM to Discord for OAuth-based linking.</CardDescription>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-border/70 bg-muted/40 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/20">
                    <FontAwesomeIcon icon={faKey} className="size-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Enable Auth Feature</p>
                    <p className="text-xs text-muted-foreground">
                      Enables Discord linking on public invites and for admin accounts.{' '}
                      <span className="text-warning">
                        This is automatically enabled if Bot Configuration or Discord membership requirement is enabled below.
                      </span>
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
                    disabled={oauthDisabled}
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
                    disabled={oauthDisabled}
                    placeholder="********"
                  />
                  <p className="text-xs text-muted-foreground">
                    {clientSecretConfigured ? 'Secret is already configured. Leave blank to keep it.' : 'Enter your client secret.'}
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-4">
                    <Label htmlFor="oauth_auth_url">Authorization URL</Label>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="oauth-auth-override" className="text-xs text-muted-foreground">
                        Override
                      </Label>
                      <Switch
                        id="oauth-auth-override"
                        checked={useOauthOverride}
                        onCheckedChange={handleOauthOverrideToggle}
                        disabled={oauthDisabled}
                      />
                    </div>
                  </div>
                  <Input
                    id="oauth_auth_url"
                    type="url"
                    className="font-mono"
                    value={oauthAuthInputValue}
                    onChange={(e) => handleChange('oauth_auth_url', e.target.value)}
                    disabled={oauthDisabled || !useOauthOverride}
                    placeholder="https://discord.com/api/v10/oauth2/authorize"
                  />
                  <p className="text-xs text-muted-foreground">
                    {useOauthOverride ? (
                      'This overrides the generated URL used for invite links. Use {STATE} to preserve the runtime state value.'
                    ) : (
                      'Generated from the Client ID and Invite Redirect URI. The state value is filled in at runtime.'
                    )}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="redirect_uri_invite">Invite Redirect URI</Label>
                  <div className="relative">
                    <Input
                      id="redirect_uri_invite"
                      type="url"
                      className="pr-10 font-mono"
                      value={formMeta.redirect_uri_invite}
                      readOnly
                      disabled
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-2 top-1/2 h-7 w-7 -translate-y-1/2"
                      onClick={() => handleCopy('Invite Redirect URI', formMeta.redirect_uri_invite)}
                      disabled={!formMeta.redirect_uri_invite}
                      aria-label="Copy invite redirect URI"
                    >
                      <FontAwesomeIcon icon={faCopy} className="size-4" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="redirect_uri_admin">Admin Redirect URI</Label>
                  <div className="relative">
                    <Input
                      id="redirect_uri_admin"
                      type="url"
                      className="pr-10 font-mono"
                      value={formMeta.redirect_uri_admin}
                      readOnly
                      disabled
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-2 top-1/2 h-7 w-7 -translate-y-1/2"
                      onClick={() => handleCopy('Admin Redirect URI', formMeta.redirect_uri_admin)}
                      disabled={!formMeta.redirect_uri_admin}
                      aria-label="Copy admin redirect URI"
                    >
                      <FontAwesomeIcon icon={faCopy} className="size-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Add BOTH of these redirect URIs to your Discord Developer Portal OAuth2 Redirects section, it is required for this feature to work. These redirect URIs are derived from the configured app base URL.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border/70 bg-muted/40 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/20">
                    <FontAwesomeIcon icon={faUsers} className="size-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Enable Discord Membership Requirement Feature</p>
                    <p className="text-xs text-muted-foreground">
                      Require invitees to be members of your Discord server before linking.
                    </p>
                  </div>
                </div>
                <Switch
                  checked={formValues.enable_membership_requirement}
                  onCheckedChange={(checked) => handleToggle('enable_membership_requirement', checked)}
                  disabled={oauthDisabled}
                />
              </div>

              <div className="rounded-lg border border-border/70 bg-background p-3 space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="guild_id">
                    Guild (Server) ID {requireGuildId && <span className="text-destructive">*</span>}
                  </Label>
                  <Input
                    id="guild_id"
                    type="text"
                    className="font-mono"
                    value={formValues.guild_id}
                    onChange={(e) => handleChange('guild_id', e.target.value)}
                    required={requireGuildId}
                    disabled={oauthDisabled || (!formValues.enable_membership_requirement && !formValues.enable_bot && !formValues.default_require_discord_guild_membership)}
                    placeholder="1234567890123456789"
                  />
                  <p className="text-xs text-muted-foreground">
                    Enable Developer Mode in Discord, right-click your server, and select "Copy ID"
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="server_invite_url">
                    Server Invite URL {requireMembershipInviteUrl && <span className="text-destructive">*</span>}
                  </Label>
                  <Input
                    id="server_invite_url"
                    type="url"
                    className="font-mono"
                    value={formValues.server_invite_url}
                    onChange={(e) => handleChange('server_invite_url', e.target.value)}
                    required={requireMembershipInviteUrl}
                    disabled={oauthDisabled || !requireMembershipInviteUrl}
                    placeholder="https://discord.gg/your-invite"
                  />
                </div>
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
                <Switch
                  id="bot-enabled"
                  checked={formValues.enable_bot}
                  onCheckedChange={(checked) => handleToggle('enable_bot', checked)}
                  disabled={oauthDisabled}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="warning">
              <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
              <AlertTitle>Under Development</AlertTitle>
              <AlertDescription>
                Bot configuration is not functional yet and is still a WIP.
              </AlertDescription>
            </Alert>
            <div className="space-y-2">
              <Label htmlFor="bot_token">Bot Token</Label>
              <Input
                id="bot_token"
                type="password"
                className="font-mono"
                value={formValues.bot_token}
                onChange={(e) => handleChange('bot_token', e.target.value)}
                disabled={oauthDisabled}
                placeholder="********"
              />
              <p className="text-xs text-muted-foreground">
                {formMeta.bot_token_set ? 'Bot token is already configured. Leave blank to keep it.' : 'Enter the bot token to enable bot features.'}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="monitored_role_id">Monitored Role ID</Label>
              <Input
                id="monitored_role_id"
                type="text"
                className="font-mono"
                value={formValues.monitored_role_id}
                onChange={(e) => handleChange('monitored_role_id', e.target.value)}
                disabled={oauthDisabled}
                placeholder="1234567890123456789"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="thread_channel_id">Thread Channel ID</Label>
              <Input
                id="thread_channel_id"
                type="text"
                className="font-mono"
                value={formValues.thread_channel_id}
                onChange={(e) => handleChange('thread_channel_id', e.target.value)}
                disabled={oauthDisabled}
                placeholder="1234567890123456789"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="bot_log_channel_id">Bot Log Channel ID</Label>
              <Input
                id="bot_log_channel_id"
                type="text"
                className="font-mono"
                value={formValues.bot_log_channel_id}
                onChange={(e) => handleChange('bot_log_channel_id', e.target.value)}
                disabled={oauthDisabled}
                placeholder="1234567890123456789"
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/40 p-3">
              <div>
                <p className="text-sm font-medium">Whitelist Sharers</p>
                <p className="text-xs text-muted-foreground">
                  Automatically whitelist users who share back.
                </p>
              </div>
              <Switch
                checked={formValues.whitelist_sharers}
                onCheckedChange={(checked) => handleToggle('whitelist_sharers', checked)}
                disabled={oauthDisabled}
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => handleTest('oauth')}
            disabled={testing || !formValues.enable_oauth}
          >
            {testing ? (
              <>
                <span className="mr-2 inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
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
                <span className="mr-2 inline-flex size-4 animate-spin rounded-full border-2 border-background border-t-transparent" />
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

export const AdminSettingsDiscordPage = () => {
  const { settings, loading, error, refresh } = useDiscordSettings()

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
