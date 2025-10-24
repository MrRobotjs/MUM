import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export type AlertType = 'success' | 'error' | 'warning' | 'info';

export type Alert = {
  id: string;
  type: AlertType;
  message: string;
  duration?: number;
};

export type AlertContextValue = {
  alerts: Alert[];
  showAlert: (type: AlertType, message: string, duration?: number) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
  dismissAlert: (id: string) => void;
};

const AlertContext = createContext<AlertContextValue | undefined>(undefined);

export const AlertProvider = ({ children }: { children: ReactNode }) => {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  const dismissAlert = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((alert) => alert.id !== id));
  }, []);

  const showAlert = useCallback(
    (type: AlertType, message: string, duration = 5000) => {
      const id = `alert-${Date.now()}-${Math.random()}`;
      const alert: Alert = { id, type, message, duration };

      setAlerts((prev) => [...prev, alert]);

      if (duration > 0) {
        setTimeout(() => {
          dismissAlert(id);
        }, duration);
      }
    },
    [dismissAlert]
  );

  const success = useCallback(
    (message: string, duration?: number) => showAlert('success', message, duration),
    [showAlert]
  );

  const error = useCallback(
    (message: string, duration?: number) => showAlert('error', message, duration),
    [showAlert]
  );

  const warning = useCallback(
    (message: string, duration?: number) => showAlert('warning', message, duration),
    [showAlert]
  );

  const info = useCallback(
    (message: string, duration?: number) => showAlert('info', message, duration),
    [showAlert]
  );

  const value: AlertContextValue = {
    alerts,
    showAlert,
    success,
    error,
    warning,
    info,
    dismissAlert,
  };

  return <AlertContext.Provider value={value}>{children}</AlertContext.Provider>;
};

export const useAlerts = (): AlertContextValue => {
  const context = useContext(AlertContext);
  if (!context) {
    throw new Error('useAlerts must be used within an AlertProvider');
  }
  return context;
};
