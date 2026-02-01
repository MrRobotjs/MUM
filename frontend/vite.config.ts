import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { visualizer } from 'rollup-plugin-visualizer';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const flaskPort = Number(env.FLASK_PORT || env.VITE_FLASK_PORT || 5000);
  const frontendPort = Number(env.FRONTEND_PORT || env.VITE_FRONTEND_PORT || 5173);

  const isAnalyze = mode === 'analyze';
  const analyzePlugins = isAnalyze
    ? [
        visualizer({
          filename: path.resolve(__dirname, '../app/static/dist/bundle-stats.html'),
          gzipSize: true,
          brotliSize: true,
          open: false,
        }),
        visualizer({
          filename: path.resolve(__dirname, '../app/static/dist/bundle-stats.json'),
          template: 'raw-data',
          gzipSize: true,
          brotliSize: true,
        }),
      ]
    : [];

  return {
    plugins: [react(), tailwindcss(), ...analyzePlugins],
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
      chunkSizeWarningLimit: 3000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (id.includes('@fortawesome/free-solid-svg-icons')) return 'fa-solid';
            if (id.includes('@fortawesome/free-brands-svg-icons')) return 'fa-brands';
            if (id.includes('@fortawesome/free-regular-svg-icons')) return 'fa-regular';
            if (id.includes('@fortawesome/fontawesome-svg-core')) return 'fa-core';
          }
        }
      }
    },
    base: '/static/dist/' // Assets will be served from /static/dist/assets/...
  };
});
