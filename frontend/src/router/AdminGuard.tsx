import React from 'react';
import { Navigate, Outlet, useLocation } from '@tanstack/react-router';
import { useAuth } from '../contexts/AuthContext';
import { ApiError } from '../util/apiClient';
import { guardDecision, LOGIN_PATH, HOME_PATH } from './routePaths';
import { Spinner } from '@/components/ui/spinner'

type Props = {
  children?: React.ReactNode
}

const AdminGuard = ({ children }: Props) => {
  const location = useLocation();
  const { session, loading, error, hasAdminAccess } = useAuth();
  // The guard can render again after navigation has begun, while its route is
  // still matched: redirecting to the login page then would replace the
  // remembered page, and redirecting home again would navigate again on every
  // render (the location store re-renders the guard synchronously).
  const toLogin = location.pathname === LOGIN_PATH
    ? null
    : <Navigate to={LOGIN_PATH} replace state={{ from: location.href }} />;
  const toHome = location.pathname === HOME_PATH ? null : <Navigate to={HOME_PATH} replace />;

  const decision = guardDecision({ loading, unauthorized: (error as ApiError)?.status === 401, failed: Boolean(error), signedIn: Boolean(session?.user), hasAdminAccess }, 'admin');

  // Show loading while session is being fetched
  if (decision === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (decision === 'login') {
    return toLogin;
  }

  if (decision === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted">
        <div className="max-w-md rounded-xl border border-red-500/30 bg-red-50 dark:bg-red-400/10 p-6 text-center">
          <h2 className="mb-2 text-lg font-semibold text-red-600 dark:text-red-400">Unable to load your session</h2>
          <p className="text-sm text-red-600 dark:text-red-400/80">{error?.message}</p>
        </div>
      </div>
    );
  }

  if (decision === 'home') {
    return toHome;
  }

  // If children are provided, render them, otherwise fall back to an Outlet
  return children ? <>{children}</> : <Outlet />;
};

export default AdminGuard;
