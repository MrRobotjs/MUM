import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode
} from 'react';
import { useMediaQuery } from '../store/mediaQueryStore';

type Theme = 'dark' | 'light' | 'system';

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const STORAGE_KEY = 'mum-ui-theme';

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export const ThemeProvider = ({
  children,
  defaultTheme = 'system'
}: {
  children: ReactNode;
  defaultTheme?: Theme;
}) => {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(STORAGE_KEY) as Theme) || defaultTheme
  );
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');

  useEffect(() => {
    const root = window.document.documentElement;

    root.classList.remove('light', 'dark');

    const resolvedTheme = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
    root.classList.add(resolvedTheme);
    root.setAttribute('data-theme', resolvedTheme);
  }, [theme, prefersDark]);

  const setTheme = (newTheme: Theme) => {
    localStorage.setItem(STORAGE_KEY, newTheme);
    setThemeState(newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextValue => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
