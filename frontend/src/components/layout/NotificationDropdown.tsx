import { useState } from 'react';
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

type Notification = {
  id: string;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  type?: 'info' | 'warning' | 'error' | 'success';
};

export const NotificationDropdown = () => {
  const navigate = useNavigate();

  // Mock notifications - replace with actual data from API/hook
  const [notifications, setNotifications] = useState<Notification[]>([
    {
      id: '1',
      title: 'User Limit Warning',
      message: 'Plex server "Main Server" is approaching the 100 user limit (95/100 users)',
      timestamp: '5 min ago',
      read: false,
      type: 'warning',
    },
    {
      id: '2',
      title: 'Server Not Synced',
      message: 'Jellyfin server "Media Server" has not been synced yet. Sync libraries and users to get started.',
      timestamp: '30 min ago',
      read: false,
      type: 'info',
    },
    {
      id: '3',
      title: 'User Accepted Invite',
      message: 'john.doe accepted their invite and now has access to Plex server "Main Server"',
      timestamp: '2 hours ago',
      read: true,
      type: 'success',
    },
  ]);

  const unreadCount = notifications.filter(n => !n.read).length;

  const handleMarkAsRead = (id: string) => {
    setNotifications(prev =>
      prev.map(n => (n.id === id ? { ...n, read: true } : n))
    );
  };

  const handleMarkAllAsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };

  const handleOpenNotifications = () => {
    navigate({ to: '/admin/notifications' });
  };

  const getNotificationIcon = (type?: string) => {
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
                <i className="fa-solid fa-bell mr-2" />
                Open Notifications
              </DropdownMenuItem>
              {unreadCount > 0 && (
                <DropdownMenuItem onClick={handleMarkAllAsRead}>
                  <i className="fa-solid fa-check-double mr-2" />
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
                onClick={() => handleMarkAsRead(notification.id)}
              >
                <div className="flex w-full items-start gap-2">
                  <i className={`${getNotificationIcon(notification.type)} mt-0.5`} />
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
                      {notification.timestamp}
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
