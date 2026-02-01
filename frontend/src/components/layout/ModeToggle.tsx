import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMoon, faSun, faDesktop } from '@fortawesome/free-solid-svg-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { Button } from '@/components/ui/button';

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
      return <FontAwesomeIcon icon={faSun} className="h-5 w-5" />;
    } else if (theme === 'dark') {
      return <FontAwesomeIcon icon={faMoon} className="h-5 w-5" />;
    } else {
      return <FontAwesomeIcon icon={faDesktop} className="h-5 w-5" />;
    }
  };

  const getLabel = () => {
    if (theme === 'light') return 'Light mode';
    if (theme === 'dark') return 'Dark mode';
    return 'System theme';
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      onClick={cycleTheme}
      aria-label={`Current theme: ${getLabel()}. Click to cycle theme`}
      title={getLabel()}
    >
      {getIcon()}
    </Button>
  );
}
