// Verification of rendered audio against approved goldens (ARCHITECTURE.md §10).
//
// Byte-equality will NOT work (FP nondeterminism, denormals, device/ABI
// differences). Compare with tolerance: per-sample epsilon + RMS error. Goldens
// live in .work/goldens/ and are effectively keyed per (device profile, ABI).
//
// Golden workflow: first run with no golden -> emit as artifact, mark
// "pending human approval"; once approved it becomes the golden.

import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { paths } from './paths.js';

const DEFAULTS = { epsilon: 1e-3, rmsDb: -60 };

/**
 * @param {string} caseId
 * @param {string} renderedWavPath
 * @param {{ epsilon?: number, rmsDb?: number, nondeterministic?: boolean }} [tol]
 */
export async function verifyRender(caseId, renderedWavPath, tol = {}) {
  const golden = path.join(paths.goldens, `${caseId}.wav`);
  if (!(await exists(golden)))
    return { status: 'pending-approval', golden, rendered: renderedWavPath };

  if (tol.nondeterministic && tol.epsilon === undefined && tol.rmsDb === undefined)
    return { status: 'skipped', reason: 'nondeterministic; no explicit tolerance set' };

  const { epsilon, rmsDb } = { ...DEFAULTS, ...tol };
  const a = decodeWav(await readFile(golden));
  const b = decodeWav(await readFile(renderedWavPath));
  const cmp = compare(a, b);

  const pass =
    cmp.shapeMatches && cmp.maxAbsDiff <= epsilon && cmp.rmsDiffDb <= rmsDb;
  return { status: pass ? 'pass' : 'fail', golden, rendered: renderedWavPath, epsilon, rmsDb, ...cmp };
}

/** Compare two decoded WAVs sample-by-sample (interleaved float comparison). */
function compare(a, b) {
  const shapeMatches =
    a.channels === b.channels && a.sampleRate === b.sampleRate;
  const n = Math.min(a.samples.length, b.samples.length);
  let maxAbsDiff = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = a.samples[i] - b.samples[i];
    const ad = Math.abs(d);
    if (ad > maxAbsDiff) maxAbsDiff = ad;
    sumSq += d * d;
  }
  const rms = n ? Math.sqrt(sumSq / n) : 0;
  const rmsDiffDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  return {
    shapeMatches,
    lengthMatches: a.samples.length === b.samples.length,
    maxAbsDiff,
    rmsDiffDb,
    comparedSamples: n,
  };
}

/**
 * Minimal canonical-WAV decoder. Supports PCM 16/24/32-bit integer and 32-bit
 * IEEE float; returns interleaved samples normalized to [-1, 1].
 * @param {Buffer} buf
 */
export function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('Not a RIFF/WAVE file.');

  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),     // 1 = PCM, 3 = IEEE float
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt || dataOffset < 0) throw new Error('Missing fmt/data chunk.');

  const { audioFormat, bitsPerSample, channels, sampleRate } = fmt;
  const bytes = bitsPerSample / 8;
  const count = Math.floor(dataLength / bytes);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = readSample(buf, dataOffset + i * bytes, audioFormat, bitsPerSample);
  return { channels, sampleRate, samples: out };
}

function readSample(buf, p, audioFormat, bits) {
  if (audioFormat === 3 && bits === 32) return buf.readFloatLE(p);
  if (audioFormat === 1) {
    switch (bits) {
      case 16: return buf.readInt16LE(p) / 32768;
      case 32: return buf.readInt32LE(p) / 2147483648;
      case 24: {
        const v = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
        return (v & 0x800000 ? v - 0x1000000 : v) / 8388608;
      }
    }
  }
  throw new Error(`Unsupported WAV sample format (audioFormat=${audioFormat}, bits=${bits}).`);
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}
