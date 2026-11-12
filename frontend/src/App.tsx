import AppRouter from './router/AppRouter';
import { AuthProvider, AlertProvider, ThemeProvider, PluginCapabilitiesProvider } from './contexts';
import { Toaster } from './components/ui/sonner';

const App = () => {
  return (
    <ThemeProvider>
      <AuthProvider>
        <PluginCapabilitiesProvider>
          <AlertProvider>
            <AppRouter />
            <Toaster />
          </AlertProvider>
        </PluginCapabilitiesProvider>
      </AuthProvider>
    </ThemeProvider>
  );
};

export default App;
