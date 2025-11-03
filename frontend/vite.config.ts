import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const flaskPort = Number(env.FLASK_PORT || env.VITE_FLASK_PORT || 5000);
  const frontendPort = Number(env.FRONTEND_PORT || env.VITE_FRONTEND_PORT || 5173);

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
      dedupe: ['react', 'react-dom']
    },
    server: {
      host: '0.0.0.0',
      port: frontendPort,
      proxy: {
        '/admin': {
          target: `http://localhost:${flaskPort}`,
          changeOrigin: true,
          secure: false
        },
        '/api': {
          target: `http://localhost:${flaskPort}`,
          changeOrigin: true,
          secure: false
        }
      }
    },
    preview: {
      port: frontendPort,
      host: '0.0.0.0'
    },
    build: {
      outDir: path.resolve(__dirname, '../app/static/dist'),
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom', '@tanstack/react-router'],
          }
        }
      },
      chunkSizeWarningLimit: 1000
    },
    base: '/static/dist/' // Assets will be served from /static/dist/assets/...
  };
});
