import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.js';
import { ConversionError } from '../src/convert.js';
import { TranscribeError } from '../src/transcribe.js';

let tmpDir;
before(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-')); });
after(() => fs.rm(tmpDir, { recursive: true, force: true }));

async function withServer(opts, fn) {
  const app = createApp({ apiKey: 'k', tmpDir, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((r) => server.close(r)); }
}

const okConvert = async (inp, out) => { await fs.writeFile(out, 'mp3'); return out; };
const okTranscribe = async () => 'texto transcrito';

function form(field = 'audio', bytes = 'abc', name = 'voz.opus') {
  const fd = new FormData();
  fd.append(field, new Blob([bytes]), name);
  return fd;
}

test('fluxo feliz devolve { text } e limpa tmp', async () => {
  await withServer({ convertFn: okConvert, transcribeFn: okTranscribe }, async (base) => {
    const res = await fetch(`${base}/transcribe`, { method: 'POST', body: form() });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: 'texto transcrito' });
  });
  assert.deepEqual(await fs.readdir(tmpDir), []);
});

test('sem arquivo devolve 400', async () => {
  await withServer({ convertFn: okConvert, transcribeFn: okTranscribe }, async (base) => {
    const res = await fetch(`${base}/transcribe`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Escolha um arquivo de áudio.' });
  });
});

test('campo com nome errado devolve 400, não 500', async () => {
  await withServer({ convertFn: okConvert, transcribeFn: okTranscribe }, async (base) => {
    const res = await fetch(`${base}/transcribe`, { method: 'POST', body: form('file') });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Escolha um arquivo de áudio.' });
  });
});

test('ConversionError devolve 422 e limpa tmp', async () => {
  const badConvert = async () => { throw new ConversionError('x'); };
  await withServer({ convertFn: badConvert, transcribeFn: okTranscribe }, async (base) => {
    const res = await fetch(`${base}/transcribe`, { method: 'POST', body: form() });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: 'Não consegui ler esse arquivo como áudio.' });
  });
  assert.deepEqual(await fs.readdir(tmpDir), []);
});

test('mp3 maior que o limite devolve 413', async () => {
  const bigConvert = async (inp, out) => { await fs.writeFile(out, Buffer.alloc(30)); return out; };
  await withServer({ convertFn: bigConvert, transcribeFn: okTranscribe, maxMp3Bytes: 25 }, async (base) => {
    const res = await fetch(`${base}/transcribe`, { method: 'POST', body: form() });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'Áudio muito longo para o plano gratuito da Groq.' });
  });
});

test('upload acima do limite do multer devolve 413', async () => {
  await withServer({ convertFn: okConvert, transcribeFn: okTranscribe, maxUploadBytes: 10 }, async (base) => {
    const res = await fetch(`${base}/transcribe`, { method: 'POST', body: form('audio', 'x'.repeat(100)) });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'Arquivo acima de 200 MB.' });
  });
});

test('TranscribeError devolve 502 com a mensagem do erro', async () => {
  const bad = async () => { throw new TranscribeError('Limite da Groq atingido. Tente mais tarde.', 429); };
  await withServer({ convertFn: okConvert, transcribeFn: bad }, async (base) => {
    const res = await fetch(`${base}/transcribe`, { method: 'POST', body: form() });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'Limite da Groq atingido. Tente mais tarde.' });
  });
  assert.deepEqual(await fs.readdir(tmpDir), []);
});

test('sem apiKey devolve 500', async () => {
  await withServer({ apiKey: undefined, convertFn: okConvert, transcribeFn: okTranscribe }, async (base) => {
    const res = await fetch(`${base}/transcribe`, { method: 'POST', body: form() });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'GROQ_API_KEY não encontrada no .env.' });
  });
});

test('GET / serve a página', async () => {
  await withServer({ convertFn: okConvert, transcribeFn: okTranscribe }, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});
