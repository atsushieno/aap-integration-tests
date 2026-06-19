import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWav } from '../src/verify.js';

/** Build a minimal canonical 16-bit PCM mono WAV from float samples. */
function makeWav16(floats, sampleRate = 48000) {
  const data = Buffer.alloc(floats.length * 2);
  floats.forEach((f, i) => {
    const v = Math.max(-1, Math.min(1, f));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  });
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('decodes a 16-bit PCM mono WAV', () => {
  const wav = makeWav16([0, 0.5, -0.5, 1, -1], 44100);
  const d = decodeWav(wav);
  assert.equal(d.channels, 1);
  assert.equal(d.sampleRate, 44100);
  assert.equal(d.samples.length, 5);
  assert.ok(Math.abs(d.samples[1] - 0.5) < 1e-3);
  assert.ok(Math.abs(d.samples[3] - 1) < 1e-3);
});

test('rejects non-RIFF data', () => {
  assert.throws(() => decodeWav(Buffer.from('not a wav file at all!!')), /RIFF|WAVE/);
});
