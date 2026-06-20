// Plugin/module acquisition — download-by-commit from GitHub Actions artifacts
// (ARCHITECTURE.md §7).
//
// Resolution order per entry (first that exists wins):
//   1. .work/local/<pkg>.apk      developer override (enforced at install time,
//                                  src/install.js — local/ is preferred there)
//   2. .work/cache/<repo@commit>  durable store (survives 90-day artifact expiry)
//   3. download from the commit's Actions artifact -> populate cache
//
// Auth: a PAT in GITHUB_TOKEN (artifact-read scope).

import { mkdir, readdir, cp, access, rm } from 'node:fs/promises';
import { writeFileSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import AdmZip from 'adm-zip';
import { paths, cacheKey } from './paths.js';

/**
 * Resolve every catalog entry to APK files staged under .work/downloaded/.
 * @param {{entries: import('./catalog.js').CatalogEntry[]}} catalog
 * @param {{token?: string}} [opts]
 * @returns {Promise<{repo:string, commit:string, dir:string, files:string[]}[]>}
 */
export async function acquire(catalog, opts = {}) {
  await Promise.all(Object.values(paths).map((d) => mkdir(d, { recursive: true })));
  const token = opts.token ?? process.env.GITHUB_TOKEN;

  const results = [];
  for (const entry of catalog.entries) {
    const dir = await resolveEntry(entry, token);
    const files = await readdir(dir);
    await cp(dir, paths.downloaded, { recursive: true });
    results.push({ repo: entry.repo, commit: entry.commit, dir, files });
  }
  return results;
}

/** Returns the cache directory holding the resolved APK(s) for one entry. */
async function resolveEntry(entry, token) {
  const cacheDir = path.join(paths.cache, cacheKey(entry.repo, entry.commit));
  if (await exists(cacheDir) && (await readdir(cacheDir)).length > 0) return cacheDir;
  await downloadFromCommit(entry, cacheDir, token);
  return cacheDir;
}

/**
 * Download the named artifacts of the successful Actions run for `entry.commit`,
 * extract per `entry.files` (or all) into `destDir`.
 */
async function downloadFromCommit(entry, destDir, token) {
  if (!token)
    throw new Error(
      `No GITHUB_TOKEN; cannot download ${entry.repo}@${entry.commit}. ` +
        `Provide a PAT with artifact-read scope.`
    );
  const [owner, repo] = entry.repo.split('/');
  const octokit = new Octokit({ auth: token });

  // Most recent successful run for this exact commit (handle re-runs).
  const runs = await octokit.paginate(octokit.actions.listWorkflowRunsForRepo, {
    owner, repo, head_sha: entry.commit, status: 'success', per_page: 100,
  });
  if (runs.length === 0)
    throw new Error(
      `No successful Actions run for ${entry.repo}@${entry.commit}. ` +
        `Pin a commit whose build is green, or re-run upstream CI.`
    );
  runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Find the named artifacts across the candidate runs (newest first).
  const wanted = new Set(entry.artifacts);
  const found = new Map(); // name -> artifact
  for (const run of runs) {
    const artifacts = await octokit.paginate(octokit.actions.listWorkflowRunArtifacts, {
      owner, repo, run_id: run.id, per_page: 100,
    });
    for (const a of artifacts)
      if (wanted.has(a.name) && !found.has(a.name) && !a.expired) found.set(a.name, a);
    if (found.size === wanted.size) break;
  }

  const missing = [...wanted].filter((n) => !found.has(n));
  if (missing.length) {
    // Artifact gone (expired) AND no cache copy -> hard error (ARCHITECTURE.md §7).
    throw new Error(
      `Artifact(s) [${missing.join(', ')}] not available for ` +
        `${entry.repo}@${entry.commit} (expired or never produced). ` +
        `Bump the pin, or re-run upstream CI for that commit. No silent fallback.`
    );
  }

  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });

  for (const [name, artifact] of found) {
    const tmpZip = path.join(destDir, `.${name}.zip`);
    await downloadArtifactZip(octokit, owner, repo, artifact.id, tmpZip);
    extract(new AdmZip(tmpZip), destDir, entry.files);
    await rm(tmpZip, { force: true });
  }
}

/**
 * Stream an artifact zip to disk. Buffering large artifacts (100s of MB; aAAR
 * bundles, host APKs) in memory via octokit's ArrayBuffer is unreliable
 * ("Invalid or unsupported zip format"), so resolve the signed redirect URL and
 * stream it to a file instead.
 */
async function downloadArtifactZip(octokit, owner, repo, artifactId, destPath) {
  const resp = await octokit.request(
    'GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}',
    { owner, repo, artifact_id: artifactId, archive_format: 'zip', request: { redirect: 'manual' } }
  );
  const url = resp.headers?.location ?? resp.url;
  if (!url) throw new Error(`Could not resolve download URL for artifact ${artifactId}.`);
  const r = await fetch(url); // pre-signed blob URL; no auth header needed
  if (!r.ok || !r.body) throw new Error(`Artifact download failed: HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(destPath));
}

/** Extract a downloaded artifact zip, honoring an optional src->dest map. */
function extract(zip, destDir, filesMap) {
  if (!filesMap) {
    zip.extractAllTo(destDir, /* overwrite */ true);
    return;
  }
  for (const [src, dest] of Object.entries(filesMap)) {
    const e = zip.getEntry(src);
    if (!e) throw new Error(`Artifact has no file "${src}" (per catalog "files" map).`);
    writeFileSync(path.join(destDir, dest), e.getData());
  }
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}
