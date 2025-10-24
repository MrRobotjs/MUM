import { useState } from 'react';
import { useLogs, type LogEntry } from '../hooks/useLogs';
import { Table, type Column, PageHeader } from '../components';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { requestJson } from '../util/apiClient';
import { useAlerts } from '../contexts';

export const LogsPage = () => {
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

  const getLevelVariant = (level: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
    const levelMap: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      DEBUG: 'outline',
      INFO: 'default',
      WARNING: 'secondary',
      ERROR: 'destructive',
      CRITICAL: 'destructive',
    };
    return levelMap[level?.toUpperCase()] || 'outline';
  };

  const handleClearFilters = () => {
    setSearchMessage('');
    setEventType('');
    setRelatedUser('');
    setPage(1);
  };

  const handleClearLogs = async () => {
    try {
      await requestJson('/admin/api/v1/logs/clear', { method: 'DELETE' });
      success('Logs cleared successfully');
      setShowClearModal(false);
      refresh();
    } catch (err) {
      showError(`Failed to clear logs: ${(err as Error).message}`);
    }
  };

  const columns: Column<LogEntry>[] = [
    {
      key: 'timestamp',
      header: 'Timestamp',
      sortable: true,
      render: (log) => (
        <span className="text-xs text-muted-foreground">
          {new Date(log.timestamp).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'level',
      header: 'Level',
      render: (log) => (
        <Badge variant={getLevelVariant(log.level)}>
          {log.level || 'UNKNOWN'}
        </Badge>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      render: (log) => (
        <span className="text-sm text-muted-foreground">
          {log.source || 'system'}
        </span>
      ),
    },
    {
      key: 'message',
      header: 'Message',
      render: (log) => (
        <div className="max-w-xl">
          <div className="text-sm">{log.message}</div>
          {log.details && Object.keys(log.details).length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                View details
              </summary>
              <pre className="mt-1 rounded bg-muted p-2 text-xs">
                {JSON.stringify(log.details, null, 2)}
              </pre>
            </details>
          )}
        </div>
      ),
    },
  ];

  const totalPages = pagination?.total_pages || 1;
  const hasFilters = searchMessage || eventType || relatedUser;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
            <i className="fa-solid fa-timeline text-blue-500 text-lg" />
          </div>
          <div>
            <h1 className="text-2xl font-bold mb-1">Application Logs</h1>
            <p className="text-sm text-muted-foreground">View system events, user actions, and errors</p>
          </div>
        </div>

        {/* Clear Logs Button */}
        <div className="flex justify-end">
          <Button variant="destructive" size="sm" onClick={() => setShowClearModal(true)}>
            <i className="fa-solid fa-trash-can mr-2" /> Clear Logs
          </Button>
        </div>
      </div>

      {/* Filter Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
              <i className="fa-solid fa-filter text-primary text-sm" />
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
                  <SelectItem value="DEBUG">Debug</SelectItem>
                  <SelectItem value="INFO">Info</SelectItem>
                  <SelectItem value="WARNING">Warning</SelectItem>
                  <SelectItem value="ERROR">Error</SelectItem>
                  <SelectItem value="CRITICAL">Critical</SelectItem>
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
                  <i className="fa-solid fa-times mr-2" />
                  Clear Filters
                </Button>
              )}
            </div>
          </div>

          {/* Loading Indicator */}
          {loading && (
            <div className="text-center p-4">
              <div className="flex items-center justify-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
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
            <i className="fa-solid fa-exclamation-triangle text-destructive" />
            <span>Failed to load logs: {(error as Error).message}</span>
          </div>
        </div>
      )}

      {/* Logs Table */}
      <Card>
        <CardContent className="p-4">
          <Table
            data={logs}
            columns={columns}
            keyExtractor={(log) => log.id}
            loading={loading}
            emptyMessage="No log entries found."
            hoverable={false}
            size="sm"
          />
        </CardContent>
      </Card>

      {/* Pagination */}
      {pagination && (
        <div className="flex items-center justify-between rounded-lg border px-4 py-3 text-sm">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
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
                  <i className="fa-solid fa-trash-can mr-2" />
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

export default LogsPage;
