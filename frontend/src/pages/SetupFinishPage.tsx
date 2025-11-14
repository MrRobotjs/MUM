import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { IconCircleCheck, IconSparkles, IconUsersGroup, IconSettings, IconServer, IconBrandDiscord } from '@tabler/icons-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { SetupLayout, useSetupStatusContext } from './SetupLayout'
import { requestJson } from '../util/apiClient'
import { useAlerts } from '../contexts'

const quickLinks = [
  {
    title: 'Invite Users',
    description: 'Generate invite links and onboard people quickly.',
    icon: <IconUsersGroup className="h-5 w-5" />,
    to: '/admin/invites',
    variant: 'default' as const
  },
  {
    title: 'Review Plugins',
    description: 'Tweak media services, libraries, and sync jobs.',
    icon: <IconServer className="h-5 w-5" />,
    to: '/admin/settings/plugins',
    variant: 'secondary' as const
  },
  {
    title: 'Brand the App',
    description: 'Update colors, URLs, and general preferences.',
    icon: <IconSettings className="h-5 w-5" />,
    to: '/admin/settings/general',
    variant: 'outline' as const
  },
  {
    title: 'Enable Discord',
    description: 'Finish OAuth setup for automated role syncing.',
    icon: <IconBrandDiscord className="h-5 w-5" />,
    to: '/admin/settings/discord',
    variant: 'outline' as const
  }
]

function SetupFinishContent() {
  const navigate = useNavigate()
  const { status, refresh } = useSetupStatusContext()
  const { error: showError } = useAlerts()

  useEffect(() => {
    let active = true
    const finalizeSetup = async () => {
      if (status?.setup_complete) {
        return
      }
      try {
        await requestJson('/admin/api/v2/setup/complete', {
          method: 'POST',
          body: JSON.stringify({})
        })
        if (active) {
          await refresh()
        }
      } catch (err) {
        if (active) {
          showError(`Failed to mark setup complete: ${(err as Error).message}`)
        }
      }
    }

    finalizeSetup()
    return () => {
      active = false
    }
  }, [status?.setup_complete, refresh, showError])

  return (
    <div className="space-y-6">
      <Card className="border border-primary/40 bg-primary/5">
        <CardHeader className="text-center space-y-3">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/15 text-primary">
            <IconCircleCheck className="h-8 w-8" />
          </div>
          <CardTitle className="text-2xl">Setup Complete</CardTitle>
          <CardDescription className="text-base text-muted-foreground">
            MUM is ready for invites, automations, and day-to-day admin work.
          </CardDescription>
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <IconSparkles className="h-4 w-4" />
            <span>{status?.completed_steps?.length ?? 0} steps completed</span>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button onClick={() => navigate({ to: '/admin/dashboard' })}>Go to Admin Dashboard</Button>
          <Button variant="outline" onClick={() => navigate({ to: '/admin/settings/general' })}>
            Adjust Settings
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {quickLinks.map((link) => (
          <Card key={link.title} className="border border-border/70">
            <CardHeader className="flex flex-row items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                {link.icon}
              </div>
              <div className="flex-1">
                <CardTitle className="text-base">{link.title}</CardTitle>
                <CardDescription>{link.description}</CardDescription>
              </div>
              {link.variant === 'default' && (
                <Badge variant="outline" className="border-primary/50 text-primary">
                  Recommended
                </Badge>
              )}
            </CardHeader>
            <CardContent>
              <Button variant={link.variant} onClick={() => navigate({ to: link.to })}>
                Open
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
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
