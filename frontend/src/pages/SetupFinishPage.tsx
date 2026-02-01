import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleCheck, faStar } from '@fortawesome/free-solid-svg-icons'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { SetupLayout, useSetupStatusContext } from './SetupLayout'
import { requestJson } from '../util/apiClient'
import { useAlerts } from '../contexts'

function SetupFinishContent() {
  const navigate = useNavigate()
  const { status, refresh } = useSetupStatusContext()
  const { error: showError, success } = useAlerts()
  const [completing, setCompleting] = useState(false)

  const handleComplete = async () => {
    if (completing) {
      return
    }
    setCompleting(true)
    try {
      await requestJson('/admin/api/v2/setup/complete', {
        method: 'POST',
        body: JSON.stringify({})
      })
      await refresh()
      success('Setup completed successfully.')
      navigate({ to: '/admin/dashboard', replace: true })
    } catch (err) {
      showError(`Failed to complete setup: ${(err as Error).message}`)
      setCompleting(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card className="border border-primary/40 bg-primary/5">
        <CardHeader className="text-center space-y-3">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/15 text-primary">
            <FontAwesomeIcon icon={faCircleCheck} className="h-8 w-8" />
          </div>
          <CardTitle className="text-2xl">Setup Complete</CardTitle>
          <CardDescription className="text-base text-muted-foreground">
            MUM is ready for invites, automations, and day-to-day admin work.
          </CardDescription>
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faStar} className="h-4 w-4" />
            <span>{status?.completed_steps?.length ?? 0} steps completed</span>
          </div>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button onClick={handleComplete} disabled={completing}>
            {completing ? 'Completing...' : 'Complete Setup'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

export default function SetupFinishPage() {
  return (
    <SetupLayout
      stepId="finish"
      title="You're All Set"
      subtitle="Review key areas of the admin panel to keep everything running smoothly."
    >
      <SetupFinishContent />
    </SetupLayout>
  )
}
