/**
 * @deprecated This component is deprecated and no longer used.
 *
 * AlertToasts has been replaced by shadcn Sonner component for toast notifications.
 *
 * DO NOT USE THIS COMPONENT. It is kept for reference only.
 * Use the Toaster component from '@/components/ui/sonner' instead.
 *
 * Toast notifications are now triggered via the useAlerts hook which uses Sonner internally.
 *
 * This file can be safely deleted.
 */

import { useAlerts } from '../../contexts/AlertContext';

const alertTypeToClass = {
  success: 'alert-success',
  error: 'alert-error',
  warning: 'alert-warning',
  info: 'alert-info',
};

const alertTypeToIcon = {
  success: (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-6 w-6 shrink-0 stroke-current"
      fill="none"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  ),
  error: (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-6 w-6 shrink-0 stroke-current"
      fill="none"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  ),
  warning: (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-6 w-6 shrink-0 stroke-current"
      fill="none"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
      />
    </svg>
  ),
  info: (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-6 w-6 shrink-0 stroke-current"
      fill="none"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  ),
};

export const AlertToasts = () => {
  const { alerts, dismissAlert } = useAlerts();

  if (alerts.length === 0) return null;

  return (
    <div className="toast toast-end toast-bottom z-50">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className={`alert ${alertTypeToClass[alert.type]} shadow-lg`}
        >
          {alertTypeToIcon[alert.type]}
          <span>{alert.message}</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-circle"
            onClick={() => dismissAlert(alert.id)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
};
