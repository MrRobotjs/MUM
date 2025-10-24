import { IconMoon, IconSun, IconDeviceDesktop } from '@tabler/icons-react';
import { useTheme } from '@/contexts/ThemeContext';

export function ModeToggle() {
  const { theme, setTheme } = useTheme();

  const cycleTheme = () => {
    if (theme === 'light') {
      setTheme('dark');
    } else if (theme === 'dark') {
      setTheme('system');
    } else {
      setTheme('light');
    }
  };

  const getIcon = () => {
    if (theme === 'light') {
      return <IconSun className="h-5 w-5" />;
    } else if (theme === 'dark') {
      return <IconMoon className="h-5 w-5" />;
    } else {
      return <IconDeviceDesktop className="h-5 w-5" />;
    }
  };

  const getLabel = () => {
    if (theme === 'light') return 'Light mode';
    if (theme === 'dark') return 'Dark mode';
    return 'System theme';
  };

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={cycleTheme}
      aria-label={`Current theme: ${getLabel()}. Click to cycle theme`}
      title={getLabel()}
    >
      {getIcon()}
    </button>
  );
}
