import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSuiteName, listSuites, loadSuite } from '../src/suite.js';

test('default suite is available', () => {
  assert.equal(defaultSuiteName, 'ci');
  assert.ok(listSuites().includes(defaultSuiteName));
});

test('ci suite captures the console-run integration matrix', () => {
  assert.deepEqual(loadSuite('ci'), [
    { case: 'connectivity-mda', catalog: 'mda-ci' },
    { case: 'inspect-mda', catalog: 'mda-ci' },
    { case: 'wavetable-preset', catalog: 'wavetable-ci' },
    { case: 'uapmd-project-mda', catalog: 'uapmd-ci' },
    { case: 'project4-load', catalog: 'project4-ci' },
  ]);
});

test('all is an alias for ci', () => {
  assert.deepEqual(loadSuite('all'), loadSuite('ci'));
});

test('rejects unknown suite names', () => {
  assert.throws(() => loadSuite('missing'), /Unknown suite/);
});
