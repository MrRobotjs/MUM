import { FormEvent, useState } from 'react'
import { requestJson } from '../util/apiClient'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Separator } from '../components/ui/separator'
import { Alert, AlertDescription } from '../components/ui/alert'
import { Spinner } from '../components/ui/spinner'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCrown, faCheck, faFilm } from '@fortawesome/free-solid-svg-icons'
import { SetupLayout, useSetupStatusContext } from './SetupLayout'
import { setAccessToken } from '../util/tokenStore'

function SetupAccountContent() {
  const navigate = useNavigate()
  const { status, refresh } = useSetupStatusContext()
  const accountComplete = status?.completed_steps?.includes('account')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [plexLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!username || !password || !confirmPassword) {
      setError('Please fill in all fields.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    try {
      const response = await requestJson<{
        data?: { access_token?: string }
      }>('/api/setup/account', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
          confirm_password: confirmPassword,
        }),
      })

      const token = response?.data?.access_token
      if (token) {
        setAccessToken(token)
      }
      refresh()
      navigate({ to: '/setup/plugins', replace: true })
    } catch (err: any) {
      setError(err?.message || 'Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  // Plex single sign-on is not implemented in the Go runtime yet, so these
  // controls are disabled and never send a request.
  const startPlexSSO = async () => {
    setError(PLEX_SSO_UNAVAILABLE)
  }

  return (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {accountComplete ? (
        <Card className="border border-primary/30 bg-primary/5">
          <CardHeader className="text-center">
            <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-primary/15">
              <FontAwesomeIcon icon={faCheck} className="h-8 w-8 text-primary" />
            </div>
            <CardTitle className="text-xl">Administrator Account Ready</CardTitle>
            <CardDescription>You can proceed to enabling media services.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              Plex single sign-on is not available yet. Continue to the Plugins step.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
              <Button variant="secondary" onClick={startPlexSSO} disabled title={PLEX_SSO_UNAVAILABLE}>
                {plexLoading ? (
                  <Spinner className="mr-2 h-4 w-4" />
                ) : (
                  <FontAwesomeIcon icon={faFilm} className="mr-2 h-4 w-4" />
                )}
                {plexLoading ? 'Starting Plex...' : 'Link Plex Account'}
              </Button>
              <Button onClick={() => navigate({ to: '/setup/plugins', replace: true })}>Continue to Plugins</Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          <Card className="border border-border">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <FontAwesomeIcon icon={faCrown} className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle>Create Administrator Account</CardTitle>
                  <CardDescription>Full access account required to finish setup.</CardDescription>
                </div>
                <Badge variant="outline" className="ml-auto">
                  Required
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="setup-username">Username</Label>
                  <Input
                    id="setup-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="setup-password">Password</Label>
                  <Input
                    id="setup-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="setup-confirm">Confirm Password</Label>
                  <Input
                    id="setup-confirm"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </div>
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting && <Spinner className="mr-2 h-4 w-4" />}
                  Create Administrator Account
                </Button>
              </form>
            </CardContent>
          </Card>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs uppercase tracking-wide text-muted-foreground">or continue with</span>
            <Separator className="flex-1" />
          </div>

          <Card className="border border-primary/20 bg-muted/30">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 text-amber-600">
                  <FontAwesomeIcon icon={faFilm} className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle>Link Plex Account</CardTitle>
                  <CardDescription>Optional single sign-on for administrators.</CardDescription>
                </div>
                <Badge variant="outline" className="ml-auto border-amber-300 text-amber-700">
                  Optional
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Plex single sign-on is not available yet. You can connect a Plex account later from account settings.
              </p>
              <Button variant="outline" className="w-full" onClick={startPlexSSO} disabled title={PLEX_SSO_UNAVAILABLE}>
                {plexLoading ? (
                  <>
                    <Spinner className="mr-2 h-4 w-4" />
                    Starting Plex...
                  </>
                ) : (
                  <>
                    <FontAwesomeIcon icon={faFilm} className="mr-2 h-4 w-4" />
                    Continue with Plex
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  )
}

const PLEX_SSO_UNAVAILABLE = 'Plex single sign-on is not available yet. Use your MUM username and password.'

export default function SetupAccountPage() {
  return (
    <SetupLayout
      stepId="account"
      title="Owner Account Setup"
      subtitle="Set up the primary owner account to manage this application."
    >
      <SetupAccountContent />
    </SetupLayout>
  )
}
