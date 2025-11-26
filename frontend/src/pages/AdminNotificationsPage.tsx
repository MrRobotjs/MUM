import { useState } from 'react';
import { PageHeader } from '../components';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';

type Notification = {
  id: string;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  type: 'info' | 'warning' | 'error' | 'success';
  details?: Record<string, unknown>;
};

export const AdminNotificationsPage = () => {
  // Mock notifications - replace with actual data from API/hook
  const [notifications, setNotifications] = useState<Notification[]>([
    {
      id: '1',
      title: 'User Limit Warning',
      message: 'Plex server "Main Server" is approaching the 100 user limit (95/100 users)',
      timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      read: false,
      type: 'warning',
      details: {
        server_id: 123,
        server_nickname: 'Main Server',
        service_type: 'plex',
        current_users: 95,
        max_users: 100,
      },
    },
    {
      id: '2',
      title: 'Server Not Synced',
      message: 'Jellyfin server "Media Server" has not been synced yet. Sync libraries and users to get started.',
      timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      read: false,
      type: 'info',
      details: {
        server_id: 456,
        server_nickname: 'Media Server',
        service_type: 'jellyfin',
        needs_sync: true,
      },
    },
    {
      id: '3',
      title: 'User Accepted Invite',
      message: 'john.doe accepted their invite and now has access to Plex server "Main Server"',
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      read: true,
      type: 'success',
      details: {
        username: 'john.doe',
        server_nickname: 'Main Server',
        invite_token: 'abc123',
      },
    },
    {
      id: '4',
      title: 'Server Connection Failed',
      message: 'Failed to connect to Jellyfin server "Backup Server". Please check your API key and server URL.',
      timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      read: true,
      type: 'error',
      details: {
        server_id: 789,
        server_nickname: 'Backup Server',
        service_type: 'jellyfin',
        error: 'Invalid API key or unreachable server',
      },
    },
    {
      id: '5',
      title: 'Server Not Synced',
      message: 'Plex server "Secondary Plex" has not been synced. Click to sync libraries and users.',
      timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      read: true,
      type: 'info',
      details: {
        server_id: 999,
        server_nickname: 'Secondary Plex',
        service_type: 'plex',
        needs_sync: true,
      },
    },
  ]);

  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredNotifications = notifications.filter((notification) => {
    if (filter === 'unread' && notification.read) return false;
    if (typeFilter !== 'all' && notification.type !== typeFilter) return false;
    if (searchQuery && !notification.title.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !notification.message.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const unreadCount = notifications.filter((n) => !n.read).length;

  const handleMarkAsRead = (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
  };

  const handleMarkAllAsRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const handleDeleteNotification = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'error':
        return 'fa-solid fa-circle-exclamation text-destructive';
      case 'warning':
        return 'fa-solid fa-triangle-exclamation text-yellow-500';
      case 'success':
        return 'fa-solid fa-circle-check text-green-500';
      default:
        return 'fa-solid fa-circle-info text-blue-500';
    }
  };

  const getNotificationBadgeVariant = (type: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
    switch (type) {
      case 'error':
        return 'destructive';
      case 'warning':
        return 'secondary';
      case 'success':
        return 'default';
      default:
        return 'outline';
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min${diffMins !== 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    return date.toLocaleDateString();
  };

  const headerActions = (
    <div className="flex gap-2">
      {unreadCount > 0 && (
        <Button variant="outline" size="sm" onClick={handleMarkAllAsRead}>
          <i className="fa-solid fa-check-double mr-2" />
          Mark all as read
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description="View and manage your system notifications"
        actions={headerActions}
      />

      {/* Filter Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
              <i className="fa-solid fa-filter text-primary text-sm" />
            </div>
            <div>
              <CardTitle>Filter Notifications</CardTitle>
              <CardDescription>Search and filter notifications by status and type</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Search */}
            <div className="space-y-2">
              <Label htmlFor="search">Search</Label>
              <Input
                id="search"
                type="text"
                placeholder="Search notifications..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            {/* Status Filter */}
            <div className="space-y-2">
              <Label htmlFor="status-filter">Status</Label>
              <Select value={filter} onValueChange={(value) => setFilter(value as 'all' | 'unread')}>
                <SelectTrigger id="status-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Notifications</SelectItem>
                  <SelectItem value="unread">Unread Only ({unreadCount})</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Type Filter */}
            <div className="space-y-2">
              <Label htmlFor="type-filter">Type</Label>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger id="type-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="success">Success</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Notifications List */}
      <div className="space-y-3">
        {filteredNotifications.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              <i className="fa-solid fa-bell-slash text-4xl mb-4 block" />
              <p className="text-lg font-medium">No notifications found</p>
              <p className="text-sm">Try adjusting your filters</p>
            </CardContent>
          </Card>
        ) : (
          filteredNotifications.map((notification) => (
            <Card key={notification.id} className={`overflow-hidden ${!notification.read ? 'border-primary/50' : ''}`}>
              <CardContent className="p-4">
                <div className="space-y-3">
                  {/* Header row */}
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 flex-1">
                      <i className={`${getNotificationIcon(notification.type)} mt-1 text-lg`} />
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-base">{notification.title}</h3>
                          <Badge variant={getNotificationBadgeVariant(notification.type)} className="text-xs">
                            {notification.type}
                          </Badge>
                          {!notification.read && (
                            <Badge variant="default" className="text-xs">
                              New
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-foreground/80">{notification.message}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatTimestamp(notification.timestamp)}
                        </p>
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {!notification.read && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleMarkAsRead(notification.id)}
                          title="Mark as read"
                        >
                          <i className="fa-solid fa-check" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteNotification(notification.id)}
                        title="Delete notification"
                      >
                        <i className="fa-solid fa-trash text-destructive" />
                      </Button>
                    </div>
                  </div>

                  {/* Details */}
                  {notification.details && Object.keys(notification.details).length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                        View details
                      </summary>
                      <pre className="mt-2 rounded bg-muted p-3 text-xs overflow-x-auto">
                        {JSON.stringify(notification.details, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
};

export default AdminNotificationsPage;
