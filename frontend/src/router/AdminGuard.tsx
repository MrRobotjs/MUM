import React from 'react';
import { Navigate, Outlet, useLocation } from '@tanstack/react-router';
import { useSession } from '../hooks/useSession';
import { ApiError } from '../util/apiClient';

type Props = {
  children?: React.ReactNode
}

const AdminGuard = ({ children }: Props) => {
  const location = useLocation();
  const { session, loading, error } = useSession();

  // Show loading while session is being fetched
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted text-muted-foreground">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (error && (error as ApiError).status === 401) {
    return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;
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

  if (!session?.user?.has_admin_access) {
    return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;
  }

  // If children are provided, render them, otherwise fall back to an Outlet
  return children ? <>{children}</> : <Outlet />;
};

export default AdminGuard;
