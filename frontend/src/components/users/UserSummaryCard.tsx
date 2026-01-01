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
};

type UserSummaryCardProps = {
  user: UserSummary;
};

export const UserSummaryCard = ({ user }: UserSummaryCardProps) => {
  const statusVariant = user.is_active ? 'secondary' : 'outline';

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
              {user.roles.admin_roles.map((role) => (
                <Badge key={role} roleKind="admin" className="text-xs font-medium" hover={false}>
                  {role}
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
