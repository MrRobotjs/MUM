import AppRouter from './router/AppRouter';
import { AuthProvider, AlertProvider, ThemeProvider } from './contexts';
import { Toaster } from './components/ui/sonner';

const App = () => {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AlertProvider>
          <AppRouter />
          <Toaster />
        </AlertProvider>
      </AuthProvider>
    </ThemeProvider>
  );
};

export default App;
