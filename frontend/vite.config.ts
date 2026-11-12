import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { visualizer } from 'rollup-plugin-visualizer';
import path from 'path';

// A build file name the Go embed keeps: no leading "_" or ".".
const embeddableName = (name: string) => name.replace(/^[_.]+/, '') || 'chunk';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendPort = Number(env.MUM_PORT || env.VITE_MUM_PORT || 5699);
  const frontendPort = Number(env.FRONTEND_PORT || env.VITE_FRONTEND_PORT || 5173);

  const isAnalyze = mode === 'analyze';
  const analyzePlugins = isAnalyze
    ? [
        visualizer({
          filename: path.resolve(import.meta.dirname, '../release/bundle-stats.html'),
          gzipSize: true,
          brotliSize: true,
          open: false,
        }),
        visualizer({
          filename: path.resolve(import.meta.dirname, '../release/bundle-stats.json'),
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
        '@': path.resolve(import.meta.dirname, 'src'),
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
      outDir: path.resolve(import.meta.dirname, '../server/dist'),
      emptyOutDir: true,
      sourcemap: false,
      chunkSizeWarningLimit: 3000,
      rolldownOptions: {
        output: {
          // `//go:embed dist/*` silently skips files whose names start with
          // "_" or "." (Rolldown names a shared Vue helper
          // "_plugin-vue_export-helper"), so no output file may start with one.
          entryFileNames: chunk => `assets/${embeddableName(chunk.name)}-[hash].js`,
          chunkFileNames: chunk => `assets/${embeddableName(chunk.name)}-[hash].js`,
          assetFileNames: asset => `assets/${embeddableName(path.parse(asset.names[0] ?? 'asset').name)}-[hash][extname]`,
          // The large Font Awesome icon sets stay in their own cacheable chunks.
          codeSplitting: {
            groups: [
              { name: 'fa-solid', test: /node_modules[\\/]@fortawesome[\\/]free-solid-svg-icons[\\/]/ },
              { name: 'fa-brands', test: /node_modules[\\/]@fortawesome[\\/]free-brands-svg-icons[\\/]/ },
              { name: 'fa-regular', test: /node_modules[\\/]@fortawesome[\\/]free-regular-svg-icons[\\/]/ },
              { name: 'fa-core', test: /node_modules[\\/]@fortawesome[\\/]fontawesome-svg-core[\\/]/ },
            ],
          },
        },
      },
    },
    base: '/'
  };
});
