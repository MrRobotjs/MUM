import { Bell, MoreVertical } from 'lucide-react';
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
  faTriangleExclamation
} from '@fortawesome/free-solid-svg-icons';

export const NotificationDropdown = () => {
  const navigate = useNavigate();
  const { notifications, unreadCount, markAsRead, markAllAsRead } = useNotifications({ limit: 5 });

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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
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
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleOpenNotifications}>
                <FontAwesomeIcon icon={faBell} className="mr-2" />
                Open Notifications
              </DropdownMenuItem>
              {unreadCount > 0 && (
                <DropdownMenuItem onClick={markAllAsRead}>
                  <FontAwesomeIcon icon={faCheckDouble} className="mr-2" />
                  Mark all as read
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {notifications.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No notifications
          </div>
        ) : (
          <div className="max-h-[400px] overflow-y-auto">
            {notifications.map((notification) => (
              <DropdownMenuItem
                key={notification.id}
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
