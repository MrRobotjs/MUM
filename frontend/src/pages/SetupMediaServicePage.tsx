import { useMemo, useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useMediaServices } from '../hooks/useMediaServices'
import { MediaServiceServers } from '../components/mediaServices'
import { SetupLayout } from './SetupLayout'
import { ApiError } from '../util/apiClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleExclamation } from '@fortawesome/free-solid-svg-icons'
import { Spinner } from '@/components/ui/spinner'

function SetupMediaServiceContent() {
  const { serviceId } = useParams({ from: '/setup/media-servers/$serviceId' })
  const resolvedServiceId = serviceId ?? ''
  const navigate = useNavigate()
  const { services, loading: servicesLoading, error: servicesError } = useMediaServices()
  const service = useMemo(
    () => services.find((item) => item.id === resolvedServiceId),
    [services, resolvedServiceId]
  )

  // Handle authentication errors by redirecting to login
  useEffect(() => {
    if (servicesError && servicesError instanceof ApiError && servicesError.status === 401) {
      window.location.href = `/login?next=/setup/media-servers/${resolvedServiceId}`
    }
  }, [servicesError, resolvedServiceId])

  if (servicesLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4 text-muted-foreground" />
        Loading media service details…
      </div>
    )
  }

  if (servicesError && !(servicesError instanceof ApiError && servicesError.status === 401)) {
    return (
      <Alert variant="destructive">
        <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
        <AlertTitle>Failed to load media services</AlertTitle>
        <AlertDescription>{(servicesError as Error).message}</AlertDescription>
      </Alert>
    )
  }

  if (!service) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate({ to: '/setup/media-servers' })}>
          Back to Media Servers
        </Button>
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
          <AlertTitle>Media service not found</AlertTitle>
          <AlertDescription>Media service "{resolvedServiceId}" could not be located.</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <MediaServiceServers service={service} setup />

      <div className="flex justify-between">
        <Button variant="outline" onClick={() => navigate({ to: '/setup/media-servers' })}>
          Back to Media Servers
        </Button>
        <Button onClick={() => navigate({ to: '/setup/app', replace: true })}>
          Continue to App Config
        </Button>
      </div>
    </div>
  )
}

export default function SetupMediaServicePage() {
  const { serviceId } = useParams({ from: '/setup/media-servers/$serviceId' })
  const { services } = useMediaServices()
  const service = useMemo(
    () => services.find((item) => item.id === serviceId),
    [services, serviceId]
  )

  return (
    <SetupLayout
      stepId="media-servers"
      title={service ? `Configure ${service.name}` : 'Configure Media Service'}
      subtitle="Add and configure servers for this media service."
    >
      <SetupMediaServiceContent />
    </SetupLayout>
  )
}


