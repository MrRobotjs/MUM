import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import {
  IconNotes,
  IconShieldCheck,
  IconPlayerPlay,
  IconCalendarTime,
  IconFolders,
} from '@tabler/icons-react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faDownload,
  faVideo,
  faCircleInfo,
  faSquareCheck,
  faSquare,
} from '@fortawesome/free-solid-svg-icons'

export type UserSettings = {
  uuid: string
  notes?: string
  is_active: boolean
  is_discord_bot_whitelisted?: boolean
  is_purge_whitelisted?: boolean
  allow_downloads?: boolean
  allow_4k_transcode?: boolean
  access_expires_at?: string | null
  libraries?: Array<{ id: string; name: string; selected: boolean }>
}

type UserSettingsCardProps = {
  settings: UserSettings | null
  loading?: boolean
  error?: Error | null
  onSave: (settings: Partial<UserSettings>) => Promise<void> | void
}

export const UserSettingsCard = ({ settings, loading, error, onSave }: UserSettingsCardProps) => {
  const [notes, setNotes] = useState(settings?.notes ?? '')
  const [isDiscordBotWhitelisted, setIsDiscordBotWhitelisted] = useState(settings?.is_discord_bot_whitelisted ?? false)
  const [isPurgeWhitelisted, setIsPurgeWhitelisted] = useState(settings?.is_purge_whitelisted ?? false)
  const [allowDownloads, setAllowDownloads] = useState(settings?.allow_downloads ?? false)
  const [allow4kTranscode, setAllow4kTranscode] = useState(settings?.allow_4k_transcode ?? false)
  const [accessExpiration, setAccessExpiration] = useState(settings?.access_expires_at ?? '')
  const [clearAccessExpiration, setClearAccessExpiration] = useState(false)
  const [selectedLibraries, setSelectedLibraries] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (settings) {
      setNotes(settings.notes ?? '')
      setIsDiscordBotWhitelisted(settings.is_discord_bot_whitelisted ?? false)
      setIsPurgeWhitelisted(settings.is_purge_whitelisted ?? false)
      setAllowDownloads(settings.allow_downloads ?? false)
      setAllow4kTranscode(settings.allow_4k_transcode ?? false)
      setAccessExpiration(settings.access_expires_at ?? '')

      if (settings.libraries) {
        const selected = new Set(settings.libraries.filter((lib) => lib.selected).map((lib) => lib.id))
        setSelectedLibraries(selected)
      }
    }
  }, [settings])

  useEffect(() => {
    if (clearAccessExpiration) {
      setAccessExpiration('')
    }
  }, [clearAccessExpiration])

  if (loading) {
    return (
      <Card className="border-border shadow-sm">
        <CardContent className="p-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Loading user settings…
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="border-border shadow-sm">
        <CardContent className="p-6 text-sm text-destructive">Failed to load settings: {error.message}</CardContent>
      </Card>
    )
  }

  const handleSelectAllLibraries = () => {
    if (settings?.libraries) {
      const allIds = new Set(settings.libraries.map((lib) => lib.id))
      setSelectedLibraries(allIds)
    }
  }

  const handleDeselectAllLibraries = () => {
    setSelectedLibraries(new Set())
  }

  const handleToggleLibrary = (libraryId: string) => {
    setSelectedLibraries((prev) => {
      const next = new Set(prev)
      if (next.has(libraryId)) next.delete(libraryId)
      else next.add(libraryId)
      return next
    })
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const payload: Partial<UserSettings> = {
        notes,
        is_discord_bot_whitelisted: isDiscordBotWhitelisted,
        is_purge_whitelisted: isPurgeWhitelisted,
        allow_downloads: allowDownloads,
        allow_4k_transcode: allow4kTranscode,
      }

      if (clearAccessExpiration) {
        payload.access_expires_at = null
      } else if (accessExpiration) {
        payload.access_expires_at = accessExpiration
      }

      if (settings?.libraries) {
        payload.libraries = settings.libraries.map((lib) => ({
          ...lib,
          selected: selectedLibraries.has(lib.id),
        }))
      }

      await onSave(payload)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconNotes className="h-5 w-5 text-muted-foreground" />
            <span>Notes & Comments</span>
          </CardTitle>
          <CardDescription>Internal notes about this user (not visible to them).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              className="min-h-[120px]"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g., Prefers 1080p remux, invited from Discord, local-only for now..."
            />
            <p className="text-xs text-muted-foreground">
              Keep track of context for this user (preferences, escalations, notes from other admins).
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Card className="bg-muted/40">
              <CardContent className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">Discord Bot Allowlist</div>
                  <p className="text-xs text-muted-foreground">
                    Allow this user to interact with the Discord bot even if global Discord bot use is limited.
                  </p>
                </div>
                <Switch
                  checked={isDiscordBotWhitelisted}
                  onCheckedChange={setIsDiscordBotWhitelisted}
                  aria-label="Discord bot allowlist"
                />
              </CardContent>
            </Card>

            <Card className="bg-muted/40">
              <CardContent className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">Purge Protection</div>
                  <p className="text-xs text-muted-foreground">Exclude this user from automatic inactivity purges.</p>
                </div>
                <Switch
                  checked={isPurgeWhitelisted}
                  onCheckedChange={setIsPurgeWhitelisted}
                  aria-label="Purge protection"
                />
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconPlayerPlay className="h-5 w-5 text-muted-foreground" />
            <span>Stream Permissions</span>
          </CardTitle>
          <CardDescription>Control high-impact streaming capabilities.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Card className="opacity-60 pointer-events-none">
            <CardContent className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1 text-muted-foreground">
                  <FontAwesomeIcon icon={faDownload} />
                  <span className="font-medium">Allow Downloads</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Manage in Plex under “Allow Sync.” This toggle is read-only here.
                </p>
              </div>
              <Switch checked={allowDownloads} disabled />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1 text-foreground">
                  <FontAwesomeIcon icon={faVideo} className="text-green-600 dark:text-green-400" />
                  <span className="font-medium">Allow 4K Transcode</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Enable only if your server can handle 4K transcoding load.
                </p>
              </div>
              <Switch
                checked={allow4kTranscode}
                onCheckedChange={setAllow4kTranscode}
                aria-label="Allow 4K transcode"
              />
            </CardContent>
          </Card>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconCalendarTime className="h-5 w-5 text-muted-foreground" />
            <span>Access Expiration</span>
          </CardTitle>
          <CardDescription>Automatically revoke access on a specific date.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Card className="bg-muted/40">
            <CardContent className="flex items-start gap-3">
              <FontAwesomeIcon icon={faCircleInfo} className="text-blue-600 dark:text-blue-400 mt-1" />
              <div className="text-sm text-muted-foreground">
                Set an expiration date to automatically revoke user access. Leave blank for permanent access.
              </div>
            </CardContent>
          </Card>

          <div className="space-y-2">
            <Label htmlFor="access_expiration">Access Expiration</Label>
            <Input
              type="date"
              id="access_expiration"
              value={accessExpiration}
              onChange={(e) => setAccessExpiration(e.target.value)}
              disabled={clearAccessExpiration}
              className="max-w-sm"
            />
            <p className="text-xs text-muted-foreground">
              User access will be automatically revoked at midnight on this date.
            </p>
          </div>

          <Card className="bg-muted/40">
            <CardContent className="flex items-start gap-3">
              <Switch
                checked={clearAccessExpiration}
                onCheckedChange={setClearAccessExpiration}
                aria-label="Clear access expiration"
              />
              <div className="space-y-1">
                <div className="font-medium">Clear Access Expiration</div>
                <div className="text-xs text-muted-foreground">
                  Remove any existing expiration date and grant permanent access.
                </div>
              </div>
            </CardContent>
          </Card>
        </CardContent>
      </Card>

      {settings?.libraries && settings.libraries.length > 0 ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <IconFolders className="h-5 w-5 text-muted-foreground" />
                <span>Library Access</span>
              </CardTitle>
              <CardDescription>Select which libraries this user can access.</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={handleSelectAllLibraries}>
                <FontAwesomeIcon icon={faSquareCheck} className="mr-2" />
                Select All
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={handleDeselectAllLibraries}>
                <FontAwesomeIcon icon={faSquare} className="mr-2" />
                Clear All
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {settings.libraries.map((library) => (
                <label
                  key={library.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm hover:border-primary transition-colors cursor-pointer"
                >
                  <Switch
                    checked={selectedLibraries.has(library.id)}
                    onCheckedChange={() => handleToggleLibrary(library.id)}
                    aria-label={`Toggle ${library.name}`}
                  />
                  <div className="flex flex-col">
                    <span className="font-medium">{library.name}</span>
                    <span className="text-xs text-muted-foreground">Library ID: {library.id}</span>
                  </div>
                </label>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={handleDeselectAllLibraries}>
          Reset Changes
        </Button>
        <Button variant="default" onClick={handleSubmit} disabled={submitting}>
          {submitting ? 'Saving…' : 'Save User Settings'}
        </Button>
      </div>
    </div>
  )
}

export default UserSettingsCard
