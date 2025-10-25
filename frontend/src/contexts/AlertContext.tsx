import { createContext, useContext, useCallback, ReactNode } from 'react';
import { toast } from 'sonner';

export type AlertType = 'success' | 'error' | 'warning' | 'info';

export type AlertContextValue = {
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
};

const AlertContext = createContext<AlertContextValue | undefined>(undefined);

export const AlertProvider = ({ children }: { children: ReactNode }) => {
  const success = useCallback((message: string, duration?: number) => {
    toast.success(message, { duration: duration ?? 5000 });
  }, []);

  const error = useCallback((message: string, duration?: number) => {
    toast.error(message, { duration: duration ?? 5000 });
  }, []);

  const warning = useCallback((message: string, duration?: number) => {
    toast.warning(message, { duration: duration ?? 5000 });
  }, []);

  const info = useCallback((message: string, duration?: number) => {
    toast.info(message, { duration: duration ?? 5000 });
  }, []);

  const value: AlertContextValue = {
    success,
    error,
    warning,
    info,
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
