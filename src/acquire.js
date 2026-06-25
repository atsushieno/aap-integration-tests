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

import { mkdir, readdir, cp, access, rm, stat } from 'node:fs/promises';
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
  console.log(`  GitHub token: ${token ? 'present' : 'missing'}${token ? '' : ' (only cached entries can be staged)'}`);

const results = [];
  const failures = [];
  for (const [index, entry] of catalog.entries.entries()) {
    const label = entryLabel(entry, index, catalog.entries.length);
    console.log(`  ${label}`);
    let resolved;
    try {
      resolved = await resolveEntry(entry, token, label);
    } catch (e) {
      if (!token) {
        failures.push(`${label}: ${e.message ?? e}`);
        continue;
      }
      throw new Error(`${label} failed: ${e.message ?? e}`);
    }
    const { dir, source } = resolved;
    const files = await readdir(dir);
    console.log(`    stage ${files.length} file(s) from ${source}: ${files.join(', ')}`);
    await cp(dir, paths.downloaded, { recursive: true });
    results.push({ repo: entry.repo, commit: entry.commit, dir, files });
  }
  if (failures.length) {
    throw new Error(
      `Acquisition could not stage ${failures.length} uncached entr(y/ies) without GITHUB_TOKEN:\n` +
      failures.map((f) => `  - ${f}`).join('\n')
    );
  }
  return results;
}

/** Returns the cache directory holding the resolved APK(s) for one entry. */
async function resolveEntry(entry, token, label) {
  const cacheDir = path.join(paths.cache, cacheKey(entry.repo, entry.commit));
  if (await exists(cacheDir)) {
    const files = await readdir(cacheDir);
    const validation = validateCacheFiles(entry, files);
    if (validation.ok) {
      console.log(`    cache hit: ${cacheDir} (${files.join(', ')})`);
      return { dir: cacheDir, source: 'cache' };
    }
    if (files.length > 0) {
      console.log(`    cache incomplete: ${cacheDir} (${validation.reason}); removing stale files: ${files.join(', ')}`);
      await rm(cacheDir, { recursive: true, force: true });
    }
  }
  console.log(`    cache miss: ${cacheDir}`);
  await downloadFromCommit(entry, cacheDir, token, label);
  return { dir: cacheDir, source: 'download' };
}

/**
 * Download the named artifacts of the successful Actions run for `entry.commit`,
 * extract per `entry.files` (or all) into `destDir`.
 */
async function downloadFromCommit(entry, destDir, token, label) {
  if (!token)
    throw new Error(
      `No GITHUB_TOKEN; cannot download ${entry.repo}@${entry.commit}. ` +
        `Provide a PAT with artifact-read scope.`
    );
  const [owner, repo] = entry.repo.split('/');
  const octokit = new Octokit({ auth: token });
  console.log(`    query successful workflow runs for ${entry.repo}@${entry.commit}`);

  // Most recent successful run for this exact commit (handle re-runs).
  const runs = await retry(`list workflow runs for ${entry.repo}@${shortSha(entry.commit)}`, () =>
    octokit.paginate(octokit.actions.listWorkflowRunsForRepo, {
      owner, repo, head_sha: entry.commit, status: 'success', per_page: 100,
    }));
  if (runs.length === 0)
    throw new Error(
      `No successful Actions run for ${entry.repo}@${entry.commit}. ` +
        `Pin a commit whose build is green, or re-run upstream CI.`
    );
  runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  console.log(`    found ${runs.length} successful run(s); newest run ${runs[0].id} (${runs[0].name ?? 'unnamed'}, ${runs[0].created_at})`);

  // Find the named artifacts across the candidate runs (newest first).
  const wanted = new Set(entry.artifacts);
  const found = new Map(); // name -> artifact
  for (const run of runs) {
    console.log(`    inspect run ${run.id} artifacts`);
    const artifacts = await retry(`list artifacts for ${entry.repo} run ${run.id}`, () =>
      octokit.paginate(octokit.actions.listWorkflowRunArtifacts, {
        owner, repo, run_id: run.id, per_page: 100,
      }));
    console.log(`      available: ${artifacts.map((a) => `${a.name}${a.expired ? ' (expired)' : ''}`).join(', ') || '(none)'}`);
    for (const a of artifacts) {
      if (wanted.has(a.name) && !found.has(a.name) && !a.expired) {
        found.set(a.name, a);
        console.log(`      selected ${a.name} id=${a.id} size=${formatBytes(a.size_in_bytes)} created=${a.created_at}`);
      }
    }
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
    console.log(`    download artifact ${name} id=${artifact.id} (${entry.repo}@${shortSha(entry.commit)})`);
    await downloadArtifactZip(octokit, owner, repo, artifact.id, tmpZip, { entry, artifactName: name, label });
    const zipStats = await stat(tmpZip).catch(() => null);
    console.log(`    extract ${name} zip (${formatBytes(zipStats?.size ?? 0)})`);
    extract(new AdmZip(tmpZip), destDir, entry.files, label, name);
    await rm(tmpZip, { force: true });
  }
}

/**
 * Stream an artifact zip to disk. Buffering large artifacts (100s of MB; aAAR
 * bundles, host APKs) in memory via octokit's ArrayBuffer is unreliable
 * ("Invalid or unsupported zip format"), so resolve the signed redirect URL and
 * stream it to a file instead.
 */
async function downloadArtifactZip(octokit, owner, repo, artifactId, destPath, context = {}) {
  const resp = await retry(`resolve artifact ${artifactId}${formatDownloadContext(context)}`, () =>
    octokit.request(
      'GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}',
      { owner, repo, artifact_id: artifactId, archive_format: 'zip', request: { redirect: 'manual' } }
    ));
  const url = resp.headers?.location;
  if (!url) {
    throw new Error(
      `Could not resolve signed download URL for artifact ${artifactId}` +
      formatDownloadContext(context) +
      `. GitHub returned status ${resp.status}; response URL was ${resp.url ?? '(none)'}.`
    );
  }
  const r = await retry(`fetch artifact ${artifactId} from ${safeHost(url)}${formatDownloadContext(context)}`, async () => {
    const response = await fetch(url); // pre-signed blob URL; no auth header needed
    if (isRetryableHttpStatus(response.status)) {
      let body = '';
      try { body = (await response.clone().text()).slice(0, 200); } catch { /* best-effort diagnostics */ }
      const err = new Error(`HTTP ${response.status} ${response.statusText}${body ? ` ${body}` : ''}`);
      err.status = response.status;
      throw err;
    }
    return response;
  });
  if (!r.ok || !r.body) {
    let body = '';
    try { body = (await r.text()).slice(0, 500); } catch { /* best-effort diagnostics */ }
    throw new Error(
      `Artifact download failed: HTTP ${r.status} ${r.statusText}` +
      formatDownloadContext(context) +
      `; artifactId=${artifactId}; urlHost=${safeHost(url)}` +
      `${body ? `; response=${JSON.stringify(body)}` : ''}`
    );
  }
  try {
    await pipeline(Readable.fromWeb(r.body), createWriteStream(destPath));
  } catch (e) {
    throw new Error(
      `Artifact download stream failed${formatDownloadContext(context)}; ` +
      `artifactId=${artifactId}; urlHost=${safeHost(url)}; ${e.message ?? e}`
    );
  }
}

/** Extract a downloaded artifact zip, honoring an optional src->dest map. */
function extract(zip, destDir, filesMap, label = '', artifactName = '') {
  if (!filesMap) {
    console.log(`      extract all entries`);
    zip.extractAllTo(destDir, /* overwrite */ true);
    return;
  }
  for (const [src, dest] of Object.entries(filesMap)) {
    const e = zip.getEntry(src);
    if (!e) {
      const names = zip.getEntries().map((entry) => entry.entryName).slice(0, 50);
      throw new Error(
        `Artifact ${artifactName ? `"${artifactName}" ` : ''}has no file "${src}" ` +
        `(per catalog "files" map)${label ? ` for ${label}` : ''}. ` +
        `First entries: ${names.join(', ') || '(none)'}`
      );
    }
    console.log(`      ${src} -> ${dest}`);
    writeFileSync(path.join(destDir, dest), e.getData());
  }
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

function validateCacheFiles(entry, files) {
  const visible = files.filter((f) => !f.startsWith('.'));
  if (entry.files) {
    const expected = Object.values(entry.files);
    const missing = expected.filter((name) => !files.includes(name));
    if (missing.length)
      return { ok: false, reason: `missing expected extracted file(s): ${missing.join(', ')}` };
    return { ok: true };
  }
  if (visible.length === 0)
    return { ok: false, reason: 'no completed non-temporary files' };
  return { ok: true };
}

function entryLabel(entry, index, total) {
  return `[${index + 1}/${total}] ${entry.repo}@${shortSha(entry.commit)} artifacts:[${entry.artifacts.join(',')}]`;
}

function shortSha(sha) {
  return String(sha).slice(0, 12);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return '(invalid-url)'; }
}

function formatDownloadContext(context) {
  const parts = [];
  if (context.label) parts.push(context.label);
  if (context.artifactName) parts.push(`artifact=${context.artifactName}`);
  return parts.length ? ` (${parts.join('; ')})` : '';
}

async function retry(label, fn, opts = {}) {
  const attempts = opts.attempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt >= attempts || !isRetryableError(e))
        throw e;
      const wait = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`    retry ${attempt}/${attempts - 1} ${label}: ${describeRetryableError(e)}; waiting ${wait}ms`);
      await delay(wait);
    }
  }
  throw last;
}

function isRetryableError(e) {
  const status = e?.status ?? e?.response?.status;
  if (isRetryableHttpStatus(status)) return true;
  const code = e?.code || e?.cause?.code;
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code))
    return true;
  const msg = String(e?.message ?? e);
  return /getaddrinfo|network|fetch failed|socket|timeout|terminated/i.test(msg);
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 ||
    (Number.isInteger(status) && status >= 500 && status < 600);
}

function describeRetryableError(e) {
  const status = e?.status ?? e?.response?.status;
  const code = e?.code || e?.cause?.code;
  return [code, status ? `HTTP ${status}` : '', e?.message ?? String(e)].filter(Boolean).join(' ');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
