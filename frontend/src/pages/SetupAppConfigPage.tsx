import { FormEvent, useState } from 'react'
import { addressReach, publicAddressNotes } from '../lib/publicAddress'
import { requestJson } from '../util/apiClient'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Alert, AlertDescription } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Spinner } from '../components/ui/spinner'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faGlobe, faGear, faCheck } from '@fortawesome/free-solid-svg-icons'
import { SetupLayout, useSetupStatusContext } from './SetupLayout'

function SetupAppContent() {
  const navigate = useNavigate()
  const { status, refresh } = useSetupStatusContext()
  const appComplete = status?.completed_steps?.includes('app')
  const [appName, setAppName] = useState('Multimedia User Manager')
  // Starts as the address setup is open on when people outside could reach it;
  // a home-network address is left out, since invite links would then keep it.
  const [publicAddress, setPublicAddress] = useState(() => {
    const origin = typeof window === 'undefined' ? '' : window.location.origin
    return addressReach(origin) === 'local' ? '' : origin
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!appName) {
      setError('The application name is required.')
      return
    }

    setSubmitting(true)
    try {
      const settings = { app_name: appName, public_address: publicAddress.trim() }

      await requestJson('/api/setup/app', {
        method: 'POST',
        body: JSON.stringify(settings)
      })
      try {
        await refresh()
      } catch {
        // ignore refresh errors; navigation can still proceed
      }
      navigate({ to: '/setup/finish', replace: true })
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
              <FontAwesomeIcon icon={faCheck} className="h-8 w-8 text-primary" />
            </div>
            <CardTitle className="text-xl">Configuration Saved</CardTitle>
            <CardDescription>Your application name and public address are set.</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button onClick={() => navigate({ to: '/setup/finish', replace: true })}>Continue to Finish</Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="border border-border">
          <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <FontAwesomeIcon icon={faGear} className="h-5 w-5" />
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
                <Label htmlFor="setup-public-address">Public Address (optional)</Label>
                <Input
                  id="setup-public-address"
                  type="url"
                  placeholder="https://mum.example.com"
                  value={publicAddress}
                  onChange={(e) => setPublicAddress(e.target.value)}
                />
                {publicAddressNotes(publicAddress).map(note => <p key={note} className="text-xs text-amber-600 dark:text-amber-400">{note}</p>)}
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting && <Spinner className="mr-2 h-4 w-4" />}
                Save and Continue
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card className="border border-muted">
        <CardHeader className="flex flex-row items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <FontAwesomeIcon icon={faGlobe} className="h-5 w-5" />
          </div>
          <div>
            <CardTitle>What is the public address?</CardTitle>
            <CardDescription>The address people outside your network use to reach MUM.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground leading-relaxed">
          <p>
            Invite links and Discord sign-in use it. You can leave it empty and set it later in Settings → General: invite
            links then use the address you're browsing on, and Discord sign-in stays off.
          </p>
          <p>
            A domain name such as https://mum.example.com is best, usually through a reverse proxy that also provides https://.
            Without a domain, people outside your network can only reach MUM if your router forwards MUM's port to this computer.
          </p>
        </CardContent>
      </Card>
    </>
  )
}

export default function SetupAppConfigPage() {
  return (
    <SetupLayout stepId="app" title="Application Configuration" subtitle="Set your application name and public address.">
      <SetupAppContent />
    </SetupLayout>
  )
}
