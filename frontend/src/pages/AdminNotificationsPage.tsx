import { useState, useMemo } from 'react';
import { PageHeader } from '../components';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { useNotifications } from '../hooks/useNotifications';

export const AdminNotificationsPage = () => {
  const { notifications, unreadCount, markAsRead, markAllAsRead, deleteNotification } = useNotifications({ limit: 100 });
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredNotifications = useMemo(() => {
    return notifications.filter((notification) => {
      if (filter === 'unread' && notification.read) return false;
      if (typeFilter !== 'all' && notification.notification_type !== typeFilter) return false;
      if (searchQuery && !notification.title.toLowerCase().includes(searchQuery.toLowerCase()) &&
          !notification.message.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [notifications, filter, typeFilter, searchQuery]);

  const getNotificationIcon = (notificationType: string) => {
    switch (notificationType) {
      case 'SERVER_CONNECTION_FAILED':
        return 'fa-solid fa-circle-exclamation text-destructive';
      case 'USER_LIMIT_WARNING':
        return 'fa-solid fa-triangle-exclamation text-yellow-500';
      case 'USER_ACCEPTED_INVITE':
        return 'fa-solid fa-circle-check text-green-500';
      case 'SERVER_NOT_SYNCED':
      default:
        return 'fa-solid fa-circle-info text-blue-500';
    }
  };

  const getNotificationBadgeVariant = (notificationType: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
    switch (notificationType) {
      case 'SERVER_CONNECTION_FAILED':
        return 'destructive';
      case 'USER_LIMIT_WARNING':
        return 'secondary';
      case 'USER_ACCEPTED_INVITE':
        return 'default';
      case 'SERVER_NOT_SYNCED':
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
        <Button variant="outline" size="sm" onClick={markAllAsRead}>
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
                  <SelectItem value="USER_LIMIT_WARNING">User Limit Warning</SelectItem>
                  <SelectItem value="SERVER_NOT_SYNCED">Server Not Synced</SelectItem>
                  <SelectItem value="SERVER_CONNECTION_FAILED">Server Connection Failed</SelectItem>
                  <SelectItem value="USER_ACCEPTED_INVITE">User Accepted Invite</SelectItem>
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
              <CardContent>
                <div className="space-y-3">
                  {/* Header row */}
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 flex-1">
                      <i className={`${getNotificationIcon(notification.notification_type)} mt-1 text-lg`} />
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-base">{notification.title}</h3>
                          <Badge variant={getNotificationBadgeVariant(notification.notification_type)} className="text-xs">
                            {notification.notification_type}
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
                          onClick={() => markAsRead(notification.id)}
                          title="Mark as read"
                        >
                          <i className="fa-solid fa-check" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteNotification(notification.id)}
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
