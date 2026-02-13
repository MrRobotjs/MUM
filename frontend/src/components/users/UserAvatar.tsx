import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { getServicePalette } from '@/config/pluginMetadata';
import { Skeleton } from '../ui/skeleton';

type AvatarDisplayUser = {
  avatar_url?: string | null;
  display_name?: string | null;
  username?: string | null;
  user_type: string;
  service_type?: string | null;
};

type UserAvatarProps = {
  user: AvatarDisplayUser;
  size?: 'sm' | 'md';
  showLoadingSkeleton?: boolean;
  className?: string;
};

export const UserAvatar = ({
  user,
  size = 'sm',
  showLoadingSkeleton = false,
  className,
}: UserAvatarProps) => {
  const [avatarError, setAvatarError] = useState(false);
  const [avatarLoading, setAvatarLoading] = useState(Boolean(user.avatar_url));
  const serviceType = user.service_type?.toLowerCase();
  const isService = user.user_type.toLowerCase() === 'service';
  const palette = getServicePalette(serviceType);
  const initial = (user.display_name || user.username || 'U')[0]?.toUpperCase() ?? 'U';

  useEffect(() => {
    setAvatarError(false);
    setAvatarLoading(Boolean(user.avatar_url));
  }, [user.avatar_url]);

  const sizeClasses =
    size === 'md'
      ? 'w-12 h-12 text-xl ring-2 ring-background/50 shadow-sm'
      : 'w-8 h-8 text-sm ring-2 ring-primary/20';
  const fallbackColorClass = isService ? palette.avatar : 'bg-primary text-primary-foreground';

  if (user.avatar_url && !avatarError) {
    return (
      <div className="relative shrink-0">
        {showLoadingSkeleton && avatarLoading && (
          <Skeleton className={cn('rounded-full absolute inset-0', sizeClasses)} />
        )}
        <img
          src={user.avatar_url}
          alt={user.display_name || user.username || 'User avatar'}
          className={cn(
            'rounded-full object-cover',
            sizeClasses,
            avatarLoading && showLoadingSkeleton && 'opacity-0',
            className
          )}
          onLoad={() => setAvatarLoading(false)}
          onError={() => {
            setAvatarLoading(false);
            setAvatarError(true);
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'rounded-full flex shrink-0 items-center justify-center font-medium text-white',
        sizeClasses,
        fallbackColorClass,
        className
      )}
    >
      {initial}
    </div>
  );
};
