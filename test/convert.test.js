import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { convertToMp3, ConversionError, ffmpegPath } from '../src/convert.js';

const run = promisify(execFile);
let dir;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conv-'));
  // WAV sintético de 1 s, 440 Hz, estéreo 44.1 kHz
  await run(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-ac', '2', '-ar', '44100', path.join(dir, 'tone.wav')]);
});
after(() => fs.rm(dir, { recursive: true, force: true }));

test('converte WAV em MP3 menor', async () => {
  const out = path.join(dir, 'tone.mp3');
  const result = await convertToMp3(path.join(dir, 'tone.wav'), out);
  assert.equal(result, out);
  const [wav, mp3] = await Promise.all([fs.stat(path.join(dir, 'tone.wav')), fs.stat(out)]);
  assert.ok(mp3.size > 0);
  assert.ok(mp3.size < wav.size);
});

test('converte arquivo sem extensão (detecção pelo conteúdo)', async () => {
  const noext = path.join(dir, 'semext');
  await fs.copyFile(path.join(dir, 'tone.wav'), noext);
  const out = path.join(dir, 'semext.mp3');
  await convertToMp3(noext, out);
  assert.ok((await fs.stat(out)).size > 0);
});

test('arquivo de texto renomeado para .opus lança ConversionError', async () => {
  const fake = path.join(dir, 'fake.opus');
  await fs.writeFile(fake, 'isso nao e audio');
  await assert.rejects(convertToMp3(fake, path.join(dir, 'fake.mp3')), (err) => {
    assert.equal(err.name, 'ConversionError');
    assert.ok(err instanceof ConversionError);
    return true;
  });
});

test('arquivo vazio lança ConversionError', async () => {
  const empty = path.join(dir, 'empty.ogg');
  await fs.writeFile(empty, '');
  await assert.rejects(convertToMp3(empty, path.join(dir, 'empty.mp3')), ConversionError);
});
