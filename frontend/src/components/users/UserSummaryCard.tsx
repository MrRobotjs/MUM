import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/common/Badge';

export type UserSummary = {
  display_name?: string;
  username?: string;
  email?: string;
  user_type: string;
  created_at?: string;
  last_login_at?: string;
  is_active: boolean;
  roles: {
    admin_roles: string[];
    user_roles: string[];
  };
  admin_roles_detail?: Array<{
    name: string;
    color?: string | null;
    icon?: string | null;
    badge_style?: string | null;
    description?: string | null;
  }>;
};

type UserSummaryCardProps = {
  user: UserSummary;
};

export const UserSummaryCard = ({ user }: UserSummaryCardProps) => {
  const statusVariant = user.is_active ? 'secondary' : 'outline';
  const adminRoleBadges = user.admin_roles_detail && user.admin_roles_detail.length > 0
    ? user.admin_roles_detail
    : user.roles.admin_roles.map((role) => ({ name: role }));

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-2xl">{user.display_name ?? user.username ?? 'User'}</CardTitle>
            <p className="text-sm text-muted-foreground">{user.email ?? 'No email'}</p>
          </div>
          <Button variant={statusVariant} size="sm">
            {user.is_active ? 'Active' : 'Inactive'}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <div className="text-xs uppercase text-muted-foreground">User Type</div>
            <div className="text-base capitalize">{user.user_type}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">Created</div>
            <div className="text-base">
              {user.created_at ? new Date(user.created_at).toLocaleString() : '-'}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">Last Login</div>
            <div className="text-base">
              {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : '-'}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">Admin Roles</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {adminRoleBadges.map((role) => (
                <Badge
                  key={role.name}
                  hexColor={role.color}
                  iconClass={role.icon}
                  roleKind="admin"
                  badgeStyle={role.badge_style ?? undefined}
                  className="text-xs font-medium"
                  title={role.description ?? undefined}
                  hover={false}
                >
                  {role.name}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default UserSummaryCard;
