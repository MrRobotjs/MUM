import AppRouter from './router/AppRouter';
import { AuthProvider, AlertProvider, ThemeProvider } from './contexts';
import { AlertToasts } from './components';

const App = () => {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AlertProvider>
          <AppRouter />
          <AlertToasts />
        </AlertProvider>
      </AuthProvider>
    </ThemeProvider>
  );
};

export default App;
