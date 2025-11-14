import { FormEvent, useState } from 'react'
import { ensureCsrfToken, apiFetch } from '../util/apiClient'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Alert, AlertDescription } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { IconLoader2, IconWorld, IconSettings, IconCheck } from '@tabler/icons-react'
import { SetupLayout, useSetupStatusContext } from './SetupLayout'

function SetupAppContent() {
  const navigate = useNavigate()
  const { status } = useSetupStatusContext()
  const appComplete = status?.completed_steps?.includes('app')
  const [appName, setAppName] = useState('Multimedia User Manager')
  const [appBaseUrl, setAppBaseUrl] = useState('')
  const [appLocalUrl, setAppLocalUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!appName || !appBaseUrl) {
      setError('App name and public URL are required.')
      return
    }

    setSubmitting(true)
    try {
      await ensureCsrfToken('/admin/api/v2/auth/csrf-token')
      const form = new FormData()
      form.set('app_name', appName)
      form.set('app_base_url', appBaseUrl)
      if (appLocalUrl) form.set('app_local_url', appLocalUrl)

      const resp = await apiFetch('/setup/app', {
        method: 'POST',
        body: form,
      })

      if (resp.ok) {
        navigate('/setup/discord', { replace: true })
      } else {
        setError('Failed to save app configuration.')
      }
    } catch (err: any) {
      setError(err?.message || 'Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {appComplete ? (
        <Card className="border border-primary/30 bg-primary/5">
          <CardHeader className="text-center">
            <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-primary/15">
              <IconCheck className="h-8 w-8 text-primary" />
            </div>
            <CardTitle className="text-xl">Configuration Saved</CardTitle>
            <CardDescription>Your branding and URLs are set.</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button onClick={() => navigate({ to: '/setup/discord', replace: true })}>Continue to Discord</Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="border border-border">
          <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <IconSettings className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>App Identity</CardTitle>
                <CardDescription>Used across invites, emails, and UI headers.</CardDescription>
              </div>
              <Badge variant="outline" className="ml-auto">
                Required
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="setup-app-name">Application Name</Label>
                <Input id="setup-app-name" value={appName} onChange={(e) => setAppName(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="setup-app-base">Public URL</Label>
                <Input
                  id="setup-app-base"
                  type="url"
                  placeholder="https://mum.example.com"
                  value={appBaseUrl}
                  onChange={(e) => setAppBaseUrl(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="setup-app-local">Local URL (optional)</Label>
                <Input
                  id="setup-app-local"
                  type="url"
                  placeholder="http://192.168.1.100:5000"
                  value={appLocalUrl}
                  onChange={(e) => setAppLocalUrl(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting && <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save and Continue
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card className="border border-muted">
        <CardHeader className="flex flex-row items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <IconWorld className="h-5 w-5" />
          </div>
          <div>
            <CardTitle>Why two URLs?</CardTitle>
            <CardDescription>Public URL is required; Local URL improves LAN redirects.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground leading-relaxed">
          <p>
            Invite emails and the dashboard use the public URL. If your admins access MUM on the LAN with a different hostname,
            specify the Local URL so redirects remain fast and do not leave your network.
          </p>
        </CardContent>
      </Card>
    </>
  )
}

export default function SetupAppConfigPage() {
  return (
    <SetupLayout stepId="app" title="Application Configuration" subtitle="Set your app identity, base URL, and LAN URL.">
      <SetupAppContent />
    </SetupLayout>
  )
}
