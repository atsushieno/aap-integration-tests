// Setup-catalog loading + validation (ARCHITECTURE.md §5).
//
// A catalog is a named, flat list of download entries. The only human-authored
// fields are repo + commit + artifact names (+ optional file mapping). Nothing
// else (hashes, versionCodes, artifact ids) is authored by hand.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { catalogsDir } from './paths.js';

/**
 * @typedef {Object} CatalogEntry
 * @property {string}   repo       "owner/name"
 * @property {string}   commit     commit hash whose CI build produced the artifacts
 * @property {string[]} artifacts  GitHub Actions artifact names to download
 * @property {Object.<string,string>=} files  optional src->dest filename map
 *                                            (default: extract all)
 */

/** Load and validate a catalog by name (`catalogs/<name>.json`). */
export async function loadCatalog(name) {
  const file = path.join(catalogsDir, `${name}.json`);
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read catalog "${name}" (${file}): ${e.message}`);
  }
  const entries = raw.entries ?? [];
  validateEntries(name, entries);
  return { name: raw.name ?? name, entries };
}

export function validateEntries(name, entries) {
  if (!Array.isArray(entries))
    throw new Error(`Catalog "${name}": "entries" must be an array.`);

  entries.forEach((e, i) => {
    const at = `Catalog "${name}" entry [${i}]`;
    if (!e.repo || !/^[^/]+\/[^/]+$/.test(e.repo))
      throw new Error(`${at}: "repo" must be "owner/name".`);
    if (!e.commit || !/^[0-9a-f]{7,40}$/i.test(e.commit))
      throw new Error(`${at}: "commit" must be a commit hash.`);
    if (!Array.isArray(e.artifacts) || e.artifacts.length === 0)
      throw new Error(`${at}: "artifacts" must be a non-empty array.`);
    if (e.files && typeof e.files !== 'object')
      throw new Error(`${at}: "files" must be an object map when present.`);
    // TODO: warn on placeholder/all-zero commit hashes.
  });
}
