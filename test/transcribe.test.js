import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { transcribe, TranscribeError, GROQ_URL } from '../src/transcribe.js';

let dir, mp3;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-'));
  mp3 = path.join(dir, 'a.mp3');
  await fs.writeFile(mp3, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
});
after(() => fs.rm(dir, { recursive: true, force: true }));

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

test('envia multipart correto e devolve o texto', async () => {
  const f = fakeFetch(200, { text: 'olá mundo' });
  const text = await transcribe(mp3, { apiKey: 'k123', fetchImpl: f });
  assert.equal(text, 'olá mundo');
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, GROQ_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer k123');
  assert.ok(init.body instanceof FormData);
  assert.equal(init.body.get('model'), 'whisper-large-v3');
  assert.equal(init.body.get('response_format'), 'json');
  const file = init.body.get('file');
  assert.ok(file instanceof Blob);
  assert.equal(file.size, 4);
});

test('resposta 200 sem text devolve string vazia', async () => {
  const text = await transcribe(mp3, { apiKey: 'k', fetchImpl: fakeFetch(200, {}) });
  assert.equal(text, '');
});

test('401 vira "Chave da Groq inválida."', async () => {
  await assert.rejects(
    transcribe(mp3, { apiKey: 'k', fetchImpl: fakeFetch(401, { error: { message: 'bad key' } }) }),
    (err) => err instanceof TranscribeError && err.groqStatus === 401 && err.message === 'Chave da Groq inválida.',
  );
});

test('429 vira "Limite da Groq atingido. Tente mais tarde."', async () => {
  await assert.rejects(
    transcribe(mp3, { apiKey: 'k', fetchImpl: fakeFetch(429, {}) }),
    (err) => err.groqStatus === 429 && err.message === 'Limite da Groq atingido. Tente mais tarde.',
  );
});

test('500 vira "Erro ao falar com a Groq: <detalhe>"', async () => {
  await assert.rejects(
    transcribe(mp3, { apiKey: 'k', fetchImpl: fakeFetch(500, { error: { message: 'boom' } }) }),
    (err) => err.groqStatus === 500 && err.message === 'Erro ao falar com a Groq: boom',
  );
});

test('falha de rede vira TranscribeError sem groqStatus', async () => {
  const f = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(
    transcribe(mp3, { apiKey: 'k', fetchImpl: f }),
    (err) => err instanceof TranscribeError && err.groqStatus === undefined
      && err.message === 'Erro ao falar com a Groq: fetch failed',
  );
});
