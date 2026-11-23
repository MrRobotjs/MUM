import { appPaths } from '../router/appLinks';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useMediaServices } from '../hooks/useMediaServices';
import { MediaServiceServers } from '../components/mediaServices';
import { PageHeader } from '../components';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleExclamation } from '@fortawesome/free-solid-svg-icons';
import { Spinner } from '@/components/ui/spinner'

/** One media service's page under Media Servers: its servers. */
export const AdminSettingsMediaServicePage = () => {
  const { serviceId } = useParams({ from: appPaths.mediaService });
  const navigate = useNavigate();
  const { services, loading, error } = useMediaServices();
  const service = services.find((item) => item.id === serviceId);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4 text-muted-foreground" />
        Loading media service…
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
        <AlertTitle>Failed to load media services</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }

  if (!service) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate({ to: '/admin/settings/media-servers' })}>
          ← Back to Media Servers
        </Button>
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
          <AlertTitle>Media service not found</AlertTitle>
          <AlertDescription>Media service "{serviceId}" could not be located.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={service.name} description={`Turn ${service.name} on or off, see what MUM can do with it, and manage its servers.`} />
      <MediaServiceServers service={service} />
    </div>
  );
};

export default AdminSettingsMediaServicePage;
