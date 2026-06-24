export const defaultSuiteName = 'ci';

const suites = {
  ci: [
    { case: 'connectivity-mda', catalog: 'mda-ci' },
    { case: 'inspect-mda', catalog: 'mda-ci' },
    { case: 'wavetable-preset', catalog: 'wavetable-ci' },
    { case: 'byod-preset-output', catalog: 'byod-ci' },
    { case: 'uapmd-aap-ui-routing-byod-dexed', catalog: 'uapmd-byod-dexed-ci' },
    { case: 'uapmd-byod-preset-values', catalog: 'uapmd-byod-dexed-ci' },
    { case: 'uapmd-project-mda', catalog: 'uapmd-ci' },
    { case: 'project4-load', catalog: 'project4-ci' },
  ],
};

suites.all = suites.ci;

export function listSuites() {
  return Object.keys(suites);
}

export function loadSuite(name = defaultSuiteName) {
  const selected = suites[name];
  if (!selected) {
    throw new Error(`Unknown suite "${name}". Available suites: ${listSuites().join(', ')}`);
  }
  return selected.map((entry) => ({ ...entry }));
}
