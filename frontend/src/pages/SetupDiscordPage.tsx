import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { IconBrandDiscord } from '@tabler/icons-react'
import { SetupLayout } from './SetupLayout'
import { requestJson } from '../util/apiClient'
import { useAlerts } from '../contexts'

function SetupDiscordContent() {
  const navigate = useNavigate()
  const { success, error: showError } = useAlerts()
  const [submitting, setSubmitting] = useState(false)

  const handleSkip = async () => {
    setSubmitting(true)
    try {
      await requestJson('/admin/api/v2/setup/complete', {
        method: 'POST',
        body: JSON.stringify({ disable_discord: true })
      })
      success('Setup completed successfully')
      navigate({ to: '/admin/dashboard' })
    } catch (err) {
      showError(`Failed to complete setup: ${(err as Error).message}`)
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card className="border border-border">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
              <IconBrandDiscord className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Discord OAuth</CardTitle>
              <CardDescription>Configure client ID/secret inside Admin → Settings → Discord.</CardDescription>
            </div>
            <Badge variant="outline" className="ml-auto border-indigo-300 text-indigo-600">
              Optional
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p>
            Linking Discord lets invitees join your community server automatically or grants them extra roles. You can skip
            this step if you don't need Discord automation.
          </p>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSkip} disabled={submitting}>
          {submitting ? 'Completing Setup...' : 'Skip & Continue to Dashboard'}
        </Button>
      </div>
    </div>
  )
}

export default function SetupDiscordPage() {
  return (
    <SetupLayout
      stepId="discord"
      title="Discord Configuration"
      subtitle="Optional OAuth flow for invitees who should link Discord accounts."
    >
      <SetupDiscordContent />
    </SetupLayout>
  )
}
