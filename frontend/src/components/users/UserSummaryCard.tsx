import { Button } from '../index';

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

export const UserSummaryCard = ({ user }: UserSummaryCardProps) => (
  <section className="card border border-base-300 bg-base-100 shadow-sm">
    <div className="card-body">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="card-title text-2xl">{user.display_name ?? user.username ?? 'User'}</h2>
          <p className="text-sm text-base-content/60">{user.email ?? 'No email'}</p>
        </div>
        <Button variant={user.is_active ? 'primary' : 'secondary'} size="sm">
          {user.is_active ? 'Active' : 'Inactive'}
        </Button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-xs uppercase text-base-content/60">User Type</div>
          <div className="text-base capitalize">{user.user_type}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-base-content/60">Created</div>
          <div className="text-base">{user.created_at ? new Date(user.created_at).toLocaleString() : '—'}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-base-content/60">Last Login</div>
          <div className="text-base">{user.last_login_at ? new Date(user.last_login_at).toLocaleString() : '—'}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-base-content/60">Admin Roles</div>
          <div className="flex flex-wrap gap-1">
            {user.roles.admin_roles.map((role) => (
              <span key={role} className="badge badge-ghost badge-sm">
                {role}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  </section>
);

export default UserSummaryCard;
