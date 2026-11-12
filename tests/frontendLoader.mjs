// Loads frontend modules for `node --test` through Vite itself: each call
// runs a real `vite build` with frontend/vite.config.ts (the `@/` alias, the
// React and Tailwind plugins, `import.meta.env`), bundles the requested
// modules into one in-memory file and imports it under a unique URL. Every
// call therefore returns a fresh module instance: stores such as authStore
// never leak state between loads.
//
//   const m = await loadFrontend("export * from './src/lib/dashboard';");
//
// `mock` replaces imports whose specifier matches `filter` (a RegExp, or a
// function taking the specifier) with the source returned by
// `module(specifier)`. Specifiers are seen as written in the source file,
// including the `@/` alias.
//
//   await loadFrontend(entry, {mock: {filter: /hooks\/useSession$/, module: () => 'export const useSession=()=>null;'}});
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const frontend = fileURLToPath(new URL('../frontend/', import.meta.url));
const vite = await import(pathToFileURL(createRequire(path.join(frontend, 'package.json')).resolve('vite')).href);
// TSX, so a fixture entry may contain JSX as well as plain re-exports.
const entry = path.join(frontend, '__frontend_test_entry__.tsx');
const mocked = '\0mum-test-mock:';
const sourceRoot = path.join(frontend, 'src').replaceAll('\\', '/') + '/';

// Vite applies resolve.alias before any plugin sees an import, so an `@/`
// import arrives as an absolute path. Restore the written form for matching.
function asWritten(specifier) {
  const normalized = specifier.replaceAll('\\', '/');
  return normalized.startsWith(sourceRoot) ? '@/' + normalized.slice(sourceRoot.length) : specifier;
}

function testModules(source, mock) {
  const matches = mock && (typeof mock.filter === 'function' ? mock.filter : specifier => mock.filter.test(specifier));
  // One stub per real module, as in the app: imports of the same file through
  // different relative paths share one instance. The stub source comes from
  // the first import's written specifier.
  const written = new Map();
  return {
    name: 'mum-test-modules',
    enforce: 'pre',
    async resolveId(specifier, importer) {
      if (specifier === entry) return entry;
      if (!matches || !importer) return null;
      const asImported = asWritten(specifier);
      if (!matches(asImported)) return null;
      const resolved = await this.resolve(specifier, importer, {skipSelf: true});
      const key = resolved?.id ?? asImported;
      if (!written.has(key)) written.set(key, asImported);
      return mocked + key;
    },
    load(id) {
      if (id === entry) return source;
      if (id.startsWith(mocked)) {
        const specifier = written.get(id.slice(mocked.length));
        const contents = mock.module(specifier);
        if (typeof contents !== 'string') throw new Error(`mock for ${specifier} returned no source`);
        return contents;
      }
      return null;
    },
  };
}

// format: 'es' (default, for import()) or 'iife' (a classic script for browser
// fixture pages). Images are inlined as data URLs.
export async function bundleFrontend(source, {mock, format = 'es'} = {}) {
  const result = await vite.build({
    root: frontend,
    configFile: path.join(frontend, 'vite.config.ts'),
    mode: 'test',
    logLevel: 'silent',
    plugins: [testModules(source, mock)],
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
      modulePreload: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rolldownOptions: {
        input: entry,
        preserveEntrySignatures: 'exports-only',
        output: {format, codeSplitting: false},
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
  const chunks = outputs.filter(o => o.type === 'chunk');
  if (chunks.length !== 1 || !chunks[0].isEntry) throw new Error(`expected one bundled chunk, got ${chunks.length}`);
  return chunks[0].code;
}

export async function loadFrontend(source, options) {
  const code = await bundleFrontend(source, options);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${Math.random()}`);
}
