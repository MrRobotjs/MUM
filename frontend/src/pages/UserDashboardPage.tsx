import { UsernameChangeCard } from '../components/users/UsernameChangeCard';
import { useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { AccountDisplayCard } from '../components/users/AccountDisplayCard';
import { UserPreferencesCard } from '../components/users/UserPreferencesCard';
import { AccountEmailCard } from '../components/users/AccountEmailCard';
import { PasswordChangeCard } from '../components/users/PasswordChangeCard';
import { PlexConnectionCard } from '../components/users/PlexConnectionCard';
import { useAuth } from '../contexts/AuthContext';
import { Spinner } from '@/components/ui/spinner'

export default function UserDashboardPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { next?: string };
  const { isAuthenticated, isAdministrator, loading } = useAuth();

  useEffect(() => {
    // Wait for auth to load
    if (loading) return;

    // Read next parameter from router search
    const nextParam = search.next;

    // If authenticated as admin, redirect to admin dashboard (or next param if valid)
    if (isAuthenticated && isAdministrator) {
      const redirectTo = nextParam?.startsWith('/admin/') ? nextParam : '/admin/dashboard';
      navigate({ href: redirectTo, replace: true });
      return;
    }

    // If not authenticated, redirect to user login with next parameter
    if (!isAuthenticated) {
      const redirectNext = nextParam?.startsWith('/user/') || nextParam?.startsWith('/admin/') ? nextParam : '/user/dashboard';
      navigate({ href: `/login?next=${encodeURIComponent(redirectNext)}`, replace: true });
      return;
    }

    // If authenticated as regular user (not admin), show user dashboard
    // This is the intended behavior for regular user accounts
  }, [isAuthenticated, isAdministrator, loading, navigate, search.next]);

  // Show loading while checking auth
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (!isAuthenticated || isAdministrator) return null;

  // If we get here, user is authenticated but not an admin (regular user)
  return (
    <div className="container mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold mb-2">User Dashboard</h1>
      <p className="text-sm text-gray-500 mb-6">
        Manage your personal Plex connection, local password and contact email below.
      </p>
      <PlexConnectionCard />
      <PasswordChangeCard />
      <UsernameChangeCard />
      <AccountEmailCard />
      <AccountDisplayCard />
      <UserPreferencesCard />
    </div>
  );
}
