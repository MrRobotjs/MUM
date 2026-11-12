import { useAccountDisplay } from '../hooks/useAccountDisplay';
import { useState, useMemo } from 'react';
import { PageHeader } from '../components';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { useNotifications } from '../hooks/useNotifications';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleExclamation,
  faTriangleExclamation,
  faCircleCheck,
  faCircleInfo,
  faCheckDouble,
  faFilter,
  faBellSlash,
  faCheck,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';

export const AdminNotificationsPage = () => {
  const { formatRelative: formatTimestamp } = useAccountDisplay();
  const { notifications, unreadCount, loading, pending, error, refresh, markAsRead, markAllAsRead, dismissNotification } = useNotifications({ limit: 100 });
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

  const getNotificationIcon = (notificationType: string): { icon: typeof faCircleInfo; className: string } => {
    switch (notificationType) {
      case 'SERVER_CONNECTION_FAILED':
        return { icon: faCircleExclamation, className: 'text-destructive' };
      case 'USER_LIMIT_WARNING':
        return { icon: faTriangleExclamation, className: 'text-yellow-500' };
      case 'USER_ACCEPTED_INVITE':
        return { icon: faCircleCheck, className: 'text-green-500' };
      case 'SERVER_NOT_SYNCED':
      default:
        return { icon: faCircleInfo, className: 'text-blue-500' };
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



  const headerActions = (
    <div className="flex gap-2">
      {unreadCount > 0 && (
        <Button variant="outline" size="sm" disabled={pending||Boolean(error)||loading} onClick={markAllAsRead}>
          <FontAwesomeIcon icon={faCheckDouble} className="mr-2" />
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
              <FontAwesomeIcon icon={faFilter} className="text-primary text-sm" />
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
                  <SelectItem value="ACCOUNT_EXPIRED">Local Account Expired</SelectItem>
                  <SelectItem value="SERVICE_EXPIRED">Service Account Expired</SelectItem>
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
        {error || loading ? <Card><CardContent className="p-8 text-center text-muted-foreground"><p>{loading?'Loading notifications…':'Notifications are unavailable or a change is unconfirmed. Refresh and inspect the inbox.'}</p><Button variant="outline" onClick={() => void refresh().catch(()=>{})} disabled={loading}>Refresh</Button></CardContent></Card> : filteredNotifications.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              <FontAwesomeIcon icon={faBellSlash} className="text-4xl mb-4 block" />
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
                    <FontAwesomeIcon
                      icon={getNotificationIcon(notification.notification_type).icon}
                      className={`${getNotificationIcon(notification.notification_type).className} mt-1 text-lg`}
                    />
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
                          disabled={pending||Boolean(error)} onClick={() => markAsRead(notification.id)}
                          title="Mark as read"
                        >
                          <FontAwesomeIcon icon={faCheck} />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending||Boolean(error)} onClick={() => dismissNotification(notification.id)}
                        title="Dismiss notification"
                      >
                        <FontAwesomeIcon icon={faTrash} className="text-destructive" />
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
