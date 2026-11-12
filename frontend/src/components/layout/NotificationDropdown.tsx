import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { useNotifications } from '../../hooks/useNotifications';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBell,
  faCheckDouble,
  faCircleCheck,
  faCircleExclamation,
  faCircleInfo,
  faEllipsisVertical,
  faTriangleExclamation
} from '@fortawesome/free-solid-svg-icons';

export const NotificationDropdown = () => {
  const { formatRelative: formatTimestamp } = useAccountDisplay();
  const navigate = useNavigate();
  const { notifications, unreadCount, loading, pending, error, refresh, markAsRead, markAllAsRead } = useNotifications({ limit: 5 });

  const handleOpenNotifications = () => {
    navigate({ to: '/admin/notifications' });
  };

  const getNotificationIcon = (notificationType: string) => {
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



  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <FontAwesomeIcon icon={faBell} className="h-5 w-5" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs"
            >
              {unreadCount}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Notifications</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6">
                <FontAwesomeIcon icon={faEllipsisVertical} className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleOpenNotifications}>
                <FontAwesomeIcon icon={faBell} className="mr-2" />
                Open Notifications
              </DropdownMenuItem>
              {unreadCount > 0 && (
                <DropdownMenuItem disabled={pending||Boolean(error)||loading} onClick={markAllAsRead}>
                  <FontAwesomeIcon icon={faCheckDouble} className="mr-2" />
                  Mark all as read
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {error || loading ? <div className="p-4 text-center text-sm text-muted-foreground"><p>{loading?'Loading notifications…':'Notifications unavailable. Refresh and inspect.'}</p><Button variant="outline" onClick={() => void refresh().catch(()=>{})} disabled={loading}>Refresh</Button></div> : notifications.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No notifications
          </div>
        ) : (
          <div className="max-h-[400px] overflow-y-auto">
            {notifications.map((notification) => (
              <DropdownMenuItem
                key={notification.id}
                disabled={pending||Boolean(error)}
                className="flex cursor-pointer flex-col items-start gap-1 p-3"
                onClick={() => !notification.read && markAsRead(notification.id)}
              >
                <div className="flex w-full items-start gap-2">
                  <FontAwesomeIcon
                    icon={getNotificationIcon(notification.notification_type).icon}
                    className={`${getNotificationIcon(notification.notification_type).className} mt-0.5`}
                  />
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium leading-none">
                        {notification.title}
                      </p>
                      {!notification.read && (
                        <span className="h-2 w-2 rounded-full bg-primary" />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {notification.message}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatTimestamp(notification.timestamp)}
                    </p>
                  </div>
                </div>
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
