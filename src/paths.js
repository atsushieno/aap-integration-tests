// Working-directory layout. Everything here is gitignored and persisted across
// runs via the GitHub Actions cache (ARCHITECTURE.md §7, principle 5).

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(__dirname, '..');

export const work = path.join(repoRoot, '.work');

export const paths = {
  root: work,
  // developer-built APKs that override downloads (highest precedence)
  local: path.join(work, 'local'),
  // resolved current APKs staged for `adb install`
  downloaded: path.join(work, 'downloaded'),
  // durable store keyed by `<owner>__<repo>@<commit>` -> apk(s)
  cache: path.join(work, 'cache'),
  // approved reference output
  goldens: path.join(work, 'goldens'),
};

/** Cache key/dir for a catalog entry (sanitized for the filesystem). */
export function cacheKey(repo, commit) {
  return `${repo.replace('/', '__')}@${commit}`;
}

export const catalogsDir = path.join(repoRoot, 'catalogs');
