import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { IconBrandDiscord, IconUserPlus } from '@tabler/icons-react'
import { SetupLayout, useSetupStatusContext } from './SetupLayout'

function SetupDiscordContent() {
  const { status } = useSetupStatusContext()
  const discordComplete = status?.completed_steps?.includes('discord')

  return (
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
        <Button asChild variant={discordComplete ? 'secondary' : 'default'} className="w-full sm:w-auto">
          <a href="/admin/settings/discord">
            <IconUserPlus className="mr-2 h-4 w-4" />
            {discordComplete ? 'Review Discord Settings' : 'Open Discord Settings'}
          </a>
        </Button>
      </CardContent>
    </Card>
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
