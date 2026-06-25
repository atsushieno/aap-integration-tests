import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEntries } from '../src/catalog.js';
import { loadCatalog } from '../src/catalog.js';

const ok = [{ repo: 'owner/name', commit: 'abc1234', artifacts: ['a'] }];

test('accepts a well-formed entry', () => {
  assert.doesNotThrow(() => validateEntries('t', ok));
});

test('accepts an optional files map', () => {
  assert.doesNotThrow(() =>
    validateEntries('t', [{ ...ok[0], files: { 'app-debug.apk': 'x.apk' } }]));
});

test('rejects a bad repo', () => {
  assert.throws(() => validateEntries('t', [{ ...ok[0], repo: 'noslash' }]), /repo/);
});

test('rejects a non-hash commit', () => {
  assert.throws(() => validateEntries('t', [{ ...ok[0], commit: 'main' }]), /commit/);
});

test('rejects empty artifacts', () => {
  assert.throws(() => validateEntries('t', [{ ...ok[0], artifacts: [] }]), /artifacts/);
});

test('loads the example mda-baseline catalog', async () => {
  const c = await loadCatalog('mda-baseline');
  assert.equal(c.name, 'mda-baseline');
});

test('loads the supported plugin smoke catalog', async () => {
  const c = await loadCatalog('supported-plugins-ci');
  assert.equal(c.name, 'supported-plugins-ci');
});
