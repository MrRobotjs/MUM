import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleInfo, faCircleExclamation } from '@fortawesome/free-solid-svg-icons'

import { useMediaServices } from '../hooks/useMediaServices'
import { MediaServiceList } from '../components/mediaServices'
import { SetupLayout } from './SetupLayout'
import { ApiError } from '../util/apiClient'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

function SetupMediaServersContent() {
  const navigate = useNavigate()
  const { services, loading, error } = useMediaServices()

  // A signed-out visitor goes to sign in and comes back here.
  useEffect(() => {
    if (error && error instanceof ApiError && error.status === 401) {
      window.location.href = '/login?next=/setup/media-servers'
    }
  }, [error])

  return (
    <div className="space-y-6">
      {error && !(error instanceof ApiError && error.status === 401) ? (
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
          <AlertTitle>Error Loading Media Services</AlertTitle>
          <AlertDescription>{error instanceof Error ? error.message : 'Failed to load media services. Please try again.'}</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="info">
          <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
          <AlertTitle>Media Server Setup</AlertTitle>
          <AlertDescription>
            Each media service MUM supports is listed with what it can do. Add a server to a service, then turn it on.
          </AlertDescription>
        </Alert>
      )}

      {error ? null : <MediaServiceList services={services} loading={loading} setup />}

      <Card>
        <CardHeader>
          <CardTitle>Continue Setup</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-3">
          <Button variant="outline" onClick={() => navigate({ to: '/admin/settings/media-servers' })}>
            Open Full Media Server Settings
          </Button>
          <Button onClick={() => navigate({ to: '/setup/app', replace: true })}>
            Continue to App Config
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

export default function SetupMediaServersPage() {
  return (
    <SetupLayout stepId="media-servers" title="Media Servers" subtitle="Enable and configure your media services, then add servers.">
      <SetupMediaServersContent />
    </SetupLayout>
  )
}
