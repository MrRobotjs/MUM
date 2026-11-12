import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { visualizer } from 'rollup-plugin-visualizer';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendPort = Number(env.MUM_PORT || env.VITE_MUM_PORT || 5699);
  const frontendPort = Number(env.FRONTEND_PORT || env.VITE_FRONTEND_PORT || 5173);

  const isAnalyze = mode === 'analyze';
  const analyzePlugins = isAnalyze
    ? [
        visualizer({
          filename: path.resolve(__dirname, '../release/bundle-stats.html'),
          gzipSize: true,
          brotliSize: true,
          open: false,
        }),
        visualizer({
          filename: path.resolve(__dirname, '../release/bundle-stats.json'),
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
        '/api': {
          target: `http://127.0.0.1:${backendPort}`,
          changeOrigin: true,
          secure: false
        },
        '/ws': {
          target: `http://127.0.0.1:${backendPort}`,
          ws: true,
          changeOrigin: true
        }
      }
    },
    preview: {
      port: frontendPort,
      host: '0.0.0.0'
    },
    build: {
      // Embedded into the Go binary by server/main.go (//go:embed dist/*).
      outDir: path.resolve(__dirname, '../server/dist'),
      emptyOutDir: true,
      sourcemap: false,
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
    base: '/'
  };
});
