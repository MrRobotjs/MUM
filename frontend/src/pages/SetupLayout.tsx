import { ReactNode, createContext, useContext } from 'react'
import { Link } from '@tanstack/react-router'
import { IconCheck, IconServer, IconSettings, IconShield } from '@tabler/icons-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Alert, AlertDescription } from '../components/ui/alert'
import { cn } from '../lib/utils'
import { useSetupStatus, SetupStatus } from '../hooks/useSetupStatus'

type SetupStepId = 'account' | 'plugins' | 'app' | 'finish'

type StepDefinition = {
  id: SetupStepId
  label: string
  description: string
  href?: string
  icon: ReactNode
}

const steps: StepDefinition[] = [
  { id: 'account', label: 'Owner Account', description: 'Create administrator credentials', href: '/setup/account', icon: <IconShield className="h-4 w-4" /> },
  { id: 'plugins', label: 'Media Services', description: 'Enable Plex, Jellyfin, Emby…', href: '/setup/plugins', icon: <IconServer className="h-4 w-4" /> },
  { id: 'app', label: 'App Config', description: 'Branding & base URL', href: '/setup/app', icon: <IconSettings className="h-4 w-4" /> },
  { id: 'finish', label: 'Finish', description: 'You are all set', icon: <IconCheck className="h-4 w-4" /> },
]

type SetupStatusContextValue = {
  status: SetupStatus | null
  loading: boolean
  refresh: () => void
}

const SetupStatusContext = createContext<SetupStatusContextValue | null>(null)

export const useSetupStatusContext = () => {
  const ctx = useContext(SetupStatusContext)
  if (!ctx) {
    throw new Error('useSetupStatusContext must be used within SetupLayout')
  }
  return ctx
}

interface SetupLayoutProps {
  stepId: SetupStepId
  title: string
  subtitle: string
  children: ReactNode
}

export function SetupLayout({ stepId, title, subtitle, children }: SetupLayoutProps) {
  const { status, loading, error, refresh } = useSetupStatus()
  const completedSteps = status?.completed_steps ?? []
  const completedCount = completedSteps.filter((id) => steps.some((s) => s.id === id)).length

  return (
    <SetupStatusContext.Provider value={{ status, loading, refresh }}>
      <div className="min-h-screen bg-muted/20 px-4 py-8">
        <div className="mx-auto max-w-5xl">
          <Card className="w-full shadow-lg border border-border rounded-xl overflow-hidden pt-0">
            <CardHeader className="text-center bg-gradient-to-r from-primary/10 to-secondary/10 px-6 py-8">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/15">
                <IconShield className="h-8 w-8 text-primary" />
              </div>
              <CardTitle className="text-2xl">{title}</CardTitle>
              <CardDescription className="text-base text-muted-foreground">{subtitle}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-8 p-6 sm:p-8">
            <div>
              <div className="mb-4 flex items-center justify-between text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Setup Progress</span>
                <span>
                  {completedCount} of {steps.length} completed
                </span>
              </div>
              <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
                {steps.map((step, index) => {
                  const isCurrent = step.id === stepId
                  const isCompleted = !isCurrent && completedSteps.includes(step.id)
                  const isFuture = !isCompleted && !isCurrent
                  const content = (
                    <div className="flex flex-1 items-center gap-3">
                      <div
                        className={cn(
                          'flex h-8 w-8 items-center justify-center rounded-full text-sm',
                          isCurrent
                            ? 'bg-amber-500/90 text-white'
                            : isCompleted
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {isCompleted && !isCurrent ? <IconCheck className="h-4 w-4" /> : step.icon}
                      </div>
                      <div className="min-w-0">
                        <p
                          className={cn(
                            'text-sm font-semibold truncate',
                            isCurrent ? 'text-amber-600 dark:text-amber-400' : isCompleted ? 'text-primary' : 'text-foreground'
                          )}
                        >
                          {step.label}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">{step.description}</p>
                      </div>
                      {isCurrent && (
                        <Badge variant="outline" className="ml-auto text-xs">
                          Current
                        </Badge>
                      )}
                    </div>
                  )

                  const wrapperClasses = cn(
                    'flex flex-1 items-center gap-2 rounded-lg border px-3 py-2 transition-colors',
                    isCurrent
                      ? 'border-amber-400/60 bg-amber-50/60 dark:bg-amber-500/10'
                      : isCompleted
                        ? 'border-primary/40 bg-primary/10 hover:bg-primary/15'
                        : 'border-border bg-muted/40'
                  )

                  const clickable = step.href && (isCompleted || isCurrent)

                  return (
                    <div key={step.id} className="flex flex-1 flex-col gap-2 md:flex-row md:items-center">
                      {clickable && step.href && !isCurrent ? (
                        <Link to={step.href} className={cn(wrapperClasses, 'cursor-pointer no-underline')} prefetch="intent">
                          {content}
                        </Link>
                      ) : (
                        <div className={wrapperClasses}>{content}</div>
                      )}
                      {index < steps.length - 1 && (
                        <div
                          className={cn(
                            'hidden flex-1 self-center rounded-full md:block',
                            isFuture ? 'h-px bg-border' : 'h-px bg-primary/40'
                          )}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {children}
            </CardContent>
          </Card>
        </div>
      </div>
    </SetupStatusContext.Provider>
  )
}
