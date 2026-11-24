import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

test('API Docs navigation uses its single guarded admin route', () => {
  const router = readFileSync(new URL('../frontend/src/router/AppRouter.tsx', import.meta.url), 'utf8');
  const nav = readFileSync(new URL('../frontend/src/components/layout/NavSettings.tsx', import.meta.url), 'utf8');
  assert.match(nav, /url: '\/admin\/api-docs'/);
  assert.match(router, /path: 'admin\/api-docs'[\s\S]*?<AdminGuard>/);
  assert.doesNotMatch(router, /path: 'api-docs'/);
});
