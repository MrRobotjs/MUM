import React from 'react';
import { Navigate, Outlet, useLocation } from '@tanstack/react-router';
import { useAuth } from '../contexts/AuthContext';
import { ApiError } from '../util/apiClient';
import { Spinner } from '@/components/ui/spinner'

type Props = {
  children?: React.ReactNode
}

const AdminGuard = ({ children }: Props) => {
  const location = useLocation();
  const { session, loading, error, hasAdminAccess } = useAuth();
  // The guard can render again after navigation to the login page has begun;
  // redirecting then would replace the remembered page with the login page.
  const toLogin = location.pathname === '/admin/login'
    ? null
    : <Navigate to="/admin/login" replace state={{ from: location.href }} />;

  // Show loading while session is being fetched
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (error && (error as ApiError).status === 401) {
    return toLogin;
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted">
        <div className="max-w-md rounded-xl border border-red-500/30 bg-red-50 dark:bg-red-400/10 p-6 text-center">
          <h2 className="mb-2 text-lg font-semibold text-red-600 dark:text-red-400">Unable to load admin session</h2>
          <p className="text-sm text-red-600 dark:text-red-400/80">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!hasAdminAccess) {
    return toLogin;
  }

  // If children are provided, render them, otherwise fall back to an Outlet
  return children ? <>{children}</> : <Outlet />;
};

export default AdminGuard;
