import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleExclamation } from '@fortawesome/free-solid-svg-icons'

import { useMediaServices } from '../hooks/useMediaServices'
import { PageHeader } from '../components'
import { MediaServiceList } from '../components/mediaServices'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/** Settings → Media Servers: every supported media service, what it can do, turning it on or off, and its servers. */
export const AdminSettingsMediaServersPage = () => {
  const { services, loading, error } = useMediaServices()
  return (
    <div className="space-y-6">
      <PageHeader title="Media Servers" description="The media services MUM supports and what each can do. Add a server to a service, then turn it on." />
      {error ? (
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
          <AlertTitle>Failed to load media services</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : (
        <MediaServiceList services={services} loading={loading} />
      )}
    </div>
  )
}

export default AdminSettingsMediaServersPage
