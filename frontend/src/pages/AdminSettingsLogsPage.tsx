import { useState } from 'react';
import { useLogs, type LogEntry } from '../hooks/useLogs';
import { PageHeader } from '../components';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { requestJson } from '../util/apiClient';
import { useAlerts } from '../contexts';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Spinner } from '@/components/ui/spinner'
import {
  faTrashCan,
  faFilter,
  faTimes,
  faTriangleExclamation,
  faUserShield,
  faUser,
} from '@fortawesome/free-solid-svg-icons';

export const AdminSettingsLogsPage = () => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchMessage, setSearchMessage] = useState('');
  const [eventType, setEventType] = useState('');
  const [relatedUser, setRelatedUser] = useState('');
  const [showClearModal, setShowClearModal] = useState(false);
  const { logs, pagination, loading, error, refresh } = useLogs(page, pageSize, {
    searchMessage,
    eventType,
    relatedUser
  });
  const { success, error: showError } = useAlerts();

  const getEventTypeVariant = (eventType: string | null): 'default' | 'secondary' | 'destructive' | 'outline' => {
    if (!eventType) return 'outline';

    const typeMap: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      // Errors and failures
      ADMIN_LOGIN_FAIL: 'destructive',
      USER_LOGIN_FAIL: 'destructive',
      PLEX_AUTH_FAIL: 'destructive',
      ERROR: 'destructive',

      // Warnings
      WARNING: 'secondary',
      USER_REVOKED: 'secondary',
      INVITE_REVOKED: 'secondary',

      // Success/Info
      ADMIN_LOGIN: 'default',
      USER_LOGIN: 'default',
      SETTING_CHANGE: 'default',
      INFO: 'default',
    };
    return typeMap[eventType] || 'outline';
  };

  const formatEventType = (eventType: string | null): string => {
    if (!eventType) return 'UNKNOWN';
    return eventType.replace(/_/g, ' ');
  };

  const handleClearFilters = () => {
    setSearchMessage('');
    setEventType('');
    setRelatedUser('');
    setPage(1);
  };

  const handleClearLogs = async () => {
    try {
      await requestJson('/admin/api/v2/logs/clear', { method: 'DELETE' });
      success('Logs cleared successfully');
      setShowClearModal(false);
      refresh();
    } catch (err) {
      showError(`Failed to clear logs: ${(err as Error).message}`);
    }
  };

  const totalPages = pagination?.total_pages || 1;
  const hasFilters = searchMessage || eventType || relatedUser;

  const headerActions = (
    <Button variant="destructive" size="sm" onClick={() => setShowClearModal(true)}>
      <FontAwesomeIcon icon={faTrashCan} className="mr-2" /> Clear Logs
    </Button>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Application Logs"
        description="View system events, user actions, and errors"
        actions={headerActions}
      />

      {/* Filter Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
              <FontAwesomeIcon icon={faFilter} className="text-primary text-sm" />
            </div>
            <div>
              <CardTitle>Filter Logs</CardTitle>
              <CardDescription>Search and filter log entries by various criteria</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Search Message */}
            <div className="space-y-2">
              <Label htmlFor="search-message">Search Message</Label>
              <Input
                id="search-message"
                type="text"
                placeholder="Enter keywords..."
                value={searchMessage}
                onChange={(e) => setSearchMessage(e.target.value)}
              />
            </div>

            {/* Event Type */}
            <div className="space-y-2">
              <Label htmlFor="event-type">Event Type</Label>
              <Select value={eventType || 'all'} onValueChange={(value) => setEventType(value === 'all' ? '' : value)}>
                <SelectTrigger id="event-type">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="ADMIN_LOGIN">Admin Login</SelectItem>
                  <SelectItem value="ADMIN_LOGIN_FAIL">Admin Login Failed</SelectItem>
                  <SelectItem value="USER_LOGIN">User Login</SelectItem>
                  <SelectItem value="USER_LOGIN_FAIL">User Login Failed</SelectItem>
                  <SelectItem value="SETTING_CHANGE">Setting Change</SelectItem>
                  <SelectItem value="USER_REVOKED">User Revoked</SelectItem>
                  <SelectItem value="INVITE_REVOKED">Invite Revoked</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Related User */}
            <div className="space-y-2">
              <Label htmlFor="related-user">Related User/Admin</Label>
              <Input
                id="related-user"
                type="text"
                placeholder="Username or ID"
                value={relatedUser}
                onChange={(e) => setRelatedUser(e.target.value)}
              />
            </div>
          </div>

          {/* Per Page and Apply Button Row */}
          <div className="flex flex-col sm:flex-row gap-4 items-end">
            <div className="space-y-2 flex-1 sm:max-w-xs">
              <Label htmlFor="per-page">Results Per Page</Label>
              <Select value={pageSize.toString()} onValueChange={(value) => setPageSize(Number(value))}>
                <SelectTrigger id="per-page">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="20">20</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                  <SelectItem value="200">200</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex gap-3">
              {hasFilters && (
                <Button variant="ghost" onClick={handleClearFilters}>
                  <FontAwesomeIcon icon={faTimes} className="mr-2" />
                  Clear Filters
                </Button>
              )}
            </div>
          </div>

          {/* Loading Indicator */}
          {loading && (
            <div className="text-center p-4">
              <div className="flex items-center justify-center gap-2">
                <Spinner className="h-4 w-4" />
                <span className="text-sm text-muted-foreground">Loading logs...</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Error Display */}
      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <FontAwesomeIcon icon={faTriangleExclamation} className="text-destructive" />
            <span>Failed to load logs: {(error as Error).message}</span>
          </div>
        </div>
      )}

      {/* Logs List - Mobile Friendly */}
      <div className="space-y-3">
        {logs.length === 0 && !loading && (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              No log entries found.
            </CardContent>
          </Card>
        )}

        {logs.map((log) => (
          <Card key={log.id} className="overflow-hidden">
            <CardContent className="p-4">
              <div className="space-y-3">
                {/* Header row with event type and timestamp */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <Badge variant={getEventTypeVariant(log.event_type)} className="w-fit">
                    {formatEventType(log.event_type)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(log.timestamp).toLocaleString()}
                  </span>
                </div>

                {/* Message */}
                <div className="text-sm break-words">
                  {log.message}
                </div>

                {/* Details */}
                {log.details && Object.keys(log.details).length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                      View details
                    </summary>
                    <pre className="mt-2 rounded bg-muted p-3 text-xs overflow-x-auto">
                      {JSON.stringify(log.details, null, 2)}
                    </pre>
                  </details>
                )}

                {/* User info */}
                {(log.owner || log.local_user) && (
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {log.owner && (
                      <span>
                        <FontAwesomeIcon icon={faUserShield} className="mr-1" />
                        Admin: {log.owner.display_name || log.owner.username}
                      </span>
                    )}
                    {log.local_user && (
                      <span>
                        <FontAwesomeIcon icon={faUser} className="mr-1" />
                        User: {log.local_user.display_name || log.local_user.username}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Pagination */}
      {pagination && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 rounded-lg border px-4 py-3 text-sm">
          <div className="text-muted-foreground">
            Page {pagination.page} of {totalPages} • {pagination.total_items} entr
            {pagination.total_items === 1 ? 'y' : 'ies'}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage(page - 1)}
              disabled={page <= 1}
            >
              Previous
            </Button>
            <span className="text-muted-foreground">
              Page {page}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage(page + 1)}
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Clear Logs Confirmation Modal */}
      {showClearModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Clear All Logs?</CardTitle>
              <CardDescription>
                This will permanently delete all log entries. This action cannot be undone.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex justify-end gap-3">
                <Button variant="ghost" onClick={() => setShowClearModal(false)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={handleClearLogs}>
                  <FontAwesomeIcon icon={faTrashCan} className="mr-2" />
                  Clear Logs
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
};

export default AdminSettingsLogsPage;
