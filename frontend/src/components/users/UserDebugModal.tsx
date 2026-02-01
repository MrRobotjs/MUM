import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { requestJson } from '../../util/apiClient';
import { useAlerts } from '../../contexts';
import { IconAlertCircle } from '@tabler/icons-react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faUser,
  faCircleInfo,
  faCode,
  faTriangleExclamation,
  faLightbulb,
  faCopy,
} from '@fortawesome/free-solid-svg-icons';

interface UserDebugModalProps {
  open: boolean;
  onClose: () => void;
  userUuid: string | null;
}

interface UserInfo {
  username: string;
  user_uuid: string;
  user_type: string | null;
  external_user_id?: string;
  external_user_alt_id?: string;
  service_type?: string;
  server_name?: string;
}

interface ServiceData {
  server_id: number;
  server_name: string;
  service_type: string;
  raw_data: Record<string, unknown>;
  service_settings?: Record<string, unknown>;
}

interface DebugData {
  user_info: UserInfo;
  service_data: ServiceData[];
  has_data: boolean;
}

interface DebugResponse {
  data: DebugData;
  meta: {
    request_id: string;
  };
}

export const UserDebugModal = ({ open, onClose, userUuid }: UserDebugModalProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugData, setDebugData] = useState<DebugData | null>(null);
  const { success, error: showError } = useAlerts();

  useEffect(() => {
    if (!open || !userUuid) {
      setDebugData(null);
      setError(null);
      return;
    }

    const fetchDebugInfo = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await requestJson<DebugResponse>(`/admin/api/v2/users/${userUuid}/debug`);
        console.log('Debug API Response:', response);
        setDebugData(response.data);
      } catch (err) {
        console.error('Debug API Error:', err);
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    };

    fetchDebugInfo();
  }, [open, userUuid]);

  const handleCopyToClipboard = async () => {
    if (!debugData) return;

    const textToCopy = JSON.stringify(debugData.service_data, null, 2);
    try {
      await navigator.clipboard.writeText(textToCopy);
      success('Raw data copied to clipboard');
    } catch (err) {
      showError('Failed to copy to clipboard');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>User Debug Information</DialogTitle>
          <DialogDescription>
            Raw user data for debugging purposes
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <IconAlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!loading && !error && debugData && (
          <div className="space-y-4">
            {/* User Info Card */}
            <div className="bg-muted/50 rounded-lg p-4 border border-border">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <FontAwesomeIcon icon={faUser} className="text-primary text-sm" />
                </div>
                <div className="flex-1">
                  <h4 className="font-medium mb-1">User Information</h4>
                  <div className="flex flex-col gap-2 text-sm">
                    <div>
                      <span className="text-muted-foreground">Username:</span>{' '}
                      <span className="font-mono">{debugData.user_info.username}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">User UUID:</span>{' '}
                      <span className="font-mono">{debugData.user_info.user_uuid}</span>
                    </div>
                    {debugData.user_info.external_user_id && (
                      <div>
                        <span className="text-muted-foreground">
                          {debugData.user_info.service_type?.charAt(0).toUpperCase() + debugData.user_info.service_type?.slice(1)} User ID:
                        </span>{' '}
                        <span className="font-mono">{debugData.user_info.external_user_id}</span>
                      </div>
                    )}
                    {debugData.user_info.external_user_alt_id && (
                      <div>
                        <span className="text-muted-foreground">Alt UUID:</span>{' '}
                        <span className="font-mono text-xs">{debugData.user_info.external_user_alt_id}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {debugData.has_data ? (
              <>
                {/* Data Type Info */}
                <div className="bg-muted/50 rounded-lg p-4 border border-border">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <FontAwesomeIcon icon={faCircleInfo} className="text-primary text-sm" />
                    </div>
                    <div className="flex-1 text-sm">
                      <p className="text-foreground">
                        <strong>Data Format:</strong> JSON (Raw User Data)
                      </p>
                      <p className="text-muted-foreground mt-1">
                        This shows raw user data retrieved from media services and stored in service user records.
                        Use this for debugging user sync and service integration problems.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Code Display */}
                <div className="bg-muted/30 rounded-lg border border-border">
                  <div className="flex items-center justify-between p-3 border-b border-border bg-muted/50">
                    <div className="flex items-center gap-2">
                      <FontAwesomeIcon icon={faCode} className="text-primary text-sm" />
                      <span className="font-medium text-sm">Raw User Data</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {debugData.service_data.length} server(s) with data
                    </div>
                  </div>
                  <div className="p-4 space-y-4">
                    {debugData.service_data.map((service) => (
                      <div key={service.server_id} className="border border-border rounded-lg overflow-hidden">
                        <div className="bg-muted/50 px-3 py-2 border-b border-border">
                          <span className="font-medium text-sm">
                            {service.server_name} ({service.service_type.charAt(0).toUpperCase() + service.service_type.slice(1)})
                          </span>
                        </div>
                        <div className="p-3 overflow-hidden">
                          <div className="bg-muted/50 border border-border rounded-lg overflow-auto max-h-96">
                            <pre className="text-xs text-foreground p-4 overflow-x-auto whitespace-pre-wrap break-words">
                              <code className="break-all">{JSON.stringify(service.raw_data, null, 2)}</code>
                            </pre>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="space-y-4">
                <div className="bg-amber-500/10 rounded-lg p-8 border border-amber-500/30 text-center">
                  <div className="w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center mx-auto mb-4">
                    <FontAwesomeIcon icon={faTriangleExclamation} className="text-amber-600 dark:text-amber-400 text-2xl" />
                  </div>
                  <h5 className="font-medium mb-2">No Raw Data Available</h5>
                  <p className="text-sm text-muted-foreground mb-4">
                    This user doesn't have stored raw service data yet. This could happen if:
                  </p>
                  <ul className="text-sm text-muted-foreground text-left max-w-md mx-auto space-y-1">
                    <li>• The user hasn't been synced from the media service</li>
                    <li>• The user was created manually without service integration</li>
                    <li>• There was an error during the last sync operation</li>
                  </ul>
                </div>

                <div className="bg-primary/10 rounded-lg p-4 border border-primary/30">
                  <div className="flex items-start gap-3">
                    <FontAwesomeIcon icon={faLightbulb} className="text-primary text-sm mt-0.5" />
                    <div>
                      <h6 className="font-medium mb-1">Suggestion</h6>
                      <p className="text-sm text-muted-foreground">
                        Try running a user sync operation to fetch and store the raw data from your media service.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {debugData?.has_data && (
            <Button variant="default" onClick={handleCopyToClipboard}>
              <FontAwesomeIcon icon={faCopy} className="mr-2" />
              Copy to Clipboard
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
