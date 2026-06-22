import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUapmdProjectPluginReferences } from '../src/uapmd-project.js';

test('reads plugin instances from project4 archive graphs', async () => {
  const refs = await readUapmdProjectPluginReferences('tests/cases/project4.uapmdz');

  assert.deepEqual(refs.map((r) => r.pluginId), [
    'lv2:http://drobilla.net/plugins/mda/JX10',
    'juceaap:44657864',
    'juceaap:socalabs-wavetable',
    'lv2:http://drobilla.net/plugins/mda/EPiano',
    'lv2:http://drobilla.net/plugins/mda/DX10',
    'lv2:http://drobilla.net/plugins/mda/Piano',
  ]);

  assert.deepEqual(refs.map((r) => r.displayName), [
    'MDA JX10',
    'Dexed AAP',
    'Wavetable AAP',
    'MDA ePiano',
    'MDA DX10',
    'MDA Piano',
  ]);
  assert.deepEqual(refs.map((r) => r.trackIndex), [0, 1, 2, 3, 4, 5]);
});
