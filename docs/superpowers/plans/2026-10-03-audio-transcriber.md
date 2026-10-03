# Audio Transcriber Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página web local que recebe um áudio em qualquer formato e devolve a transcrição via Groq Whisper.

**Architecture:** Servidor Express em Node 20 com três módulos pequenos: `src/convert.js` (ffmpeg embutido converte qualquer áudio em MP3 mono 16 kHz), `src/transcribe.js` (chama a API da Groq) e `server.js` (rota `POST /transcribe` que encadeia os dois e serve `public/index.html`). O front é uma página única com JS inline.

**Tech Stack:** Node 20 (ESM), express, multer, ffmpeg-static, dotenv, `node:test` para testes. `fetch`/`FormData`/`Blob` nativos do Node.

**Spec:** `docs/superpowers/specs/2026-10-03-audio-transcriber-design.md`

## Global Constraints

- Node 20 já instalado; nenhuma instalação de sistema (sem Homebrew). ffmpeg vem de `ffmpeg-static`.
- Chave lida de `.env` na raiz como `GROQ_API_KEY`; nunca vai ao navegador. `.env` não é versionado.
- Groq: modelo `whisper-large-v3`, endpoint `https://api.groq.com/openai/v1/audio/transcriptions`, limite 25 MB por envio.
- Conversão: `-vn -ac 1 -ar 16000 -b:a 64k`, saída `.mp3`.
- Limite de upload: 200 MB. Arquivos temporários em `tmp/`, apagados em `finally`.
- Mensagens de erro ao usuário em português, exatamente como na tabela da spec.
- Sem OpenRouter, sem divisão de áudio longo, sem histórico.

## Review Focus

1. Arquivo sem extensão ou com nome estranho: ffmpeg detecta pelo conteúdo, deve converter normalmente. Teste em Task 1.
2. Arquivo vazio (0 bytes): deve virar 422 "Não consegui ler esse arquivo como áudio.", não travar. Teste em Task 1.
3. Groq devolve 200 sem `text` (silêncio): servidor devolve `{ text: "" }` e a página mostra "Nenhuma fala detectada." Teste em Task 2 e Task 4.
4. Campo multipart com nome errado (ex.: `file` em vez de `audio`): multer lança "Unexpected field"; deve virar 400, não 500 com stack. Teste em Task 3.
5. Upload acima do limite do multer: deve virar 413 com mensagem, não conexão derrubada. Teste em Task 3.

---

### Task 1: Scaffold do projeto e conversão com ffmpeg

**Files:**
- Create: `package.json`
- Create: `src/convert.js`
- Test: `test/convert.test.js`

**Interfaces:**
- Produces: `convertToMp3(inputPath: string, outputPath: string): Promise<string>` resolve com `outputPath`. Lança `ConversionError` (classe exportada, `name === 'ConversionError'`) quando o ffmpeg falha.
- Produces: `ffmpegPath` (string) reexportado para os testes gerarem áudio sintético.

- [ ] **Step 1: Criar package.json e instalar dependências**

```json
{
  "name": "audio-transcriber",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/*.test.js"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "express": "^4.21.0",
    "ffmpeg-static": "^5.2.0",
    "multer": "^2.0.0"
  }
}
```

Run: `npm install`
Expected: `node_modules/ffmpeg-static/ffmpeg` existe. Verificar: `node -e "import('ffmpeg-static').then(m=>console.log(m.default))"` imprime um caminho.

- [ ] **Step 2: Escrever o teste que falha**

`test/convert.test.js`:

```js
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
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `npm test`
Expected: FAIL com `Cannot find module '../src/convert.js'`.

- [ ] **Step 4: Implementar src/convert.js**

```js
import ffmpegStatic from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const ffmpegPath = ffmpegStatic;

export class ConversionError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'ConversionError';
  }
}

/**
 * Converte qualquer áudio que o ffmpeg leia em MP3 mono 16 kHz 64 kbps.
 * Resolve com outputPath. Lança ConversionError se o ffmpeg falhar.
 */
export async function convertToMp3(inputPath, outputPath) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', outputPath];
  try {
    await run(ffmpegPath, args, { maxBuffer: 1024 * 1024 });
    return outputPath;
  } catch (err) {
    const detail = (err.stderr || err.message || '').trim().split('\n').slice(-3).join(' ');
    throw new ConversionError(`ffmpeg não conseguiu ler o arquivo: ${detail}`, err);
  }
}
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `npm test`
Expected: 4 testes PASS em `convert.test.js`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/convert.js test/convert.test.js
git commit -m "feat: conversão de áudio para mp3 com ffmpeg-static"
```

---

### Task 2: Cliente da API da Groq

**Files:**
- Create: `src/transcribe.js`
- Test: `test/transcribe.test.js`

**Interfaces:**
- Produces: `transcribe(mp3Path: string, { apiKey: string, fetchImpl?: typeof fetch, model?: string }): Promise<string>` resolve com o texto (string vazia se a Groq não devolver `text`). Lança `TranscribeError` (classe exportada, `name === 'TranscribeError'`, propriedade `groqStatus: number|undefined`) com `message` já em português pronta para exibir.
- Produces: constante `GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'`.

- [ ] **Step 1: Escrever o teste que falha**

`test/transcribe.test.js`:

```js
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
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test`
Expected: FAIL com `Cannot find module '../src/transcribe.js'`.

- [ ] **Step 3: Implementar src/transcribe.js**

```js
import fs from 'node:fs/promises';
import path from 'node:path';

export const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

export class TranscribeError extends Error {
  constructor(message, groqStatus, cause) {
    super(message, { cause });
    this.name = 'TranscribeError';
    this.groqStatus = groqStatus;
  }
}

function messageFor(status, detail) {
  if (status === 401) return 'Chave da Groq inválida.';
  if (status === 429) return 'Limite da Groq atingido. Tente mais tarde.';
  return `Erro ao falar com a Groq: ${detail}`;
}

/**
 * Envia um MP3 à Groq e devolve o texto transcrito.
 * Lança TranscribeError com mensagem em português.
 */
export async function transcribe(mp3Path, { apiKey, fetchImpl = fetch, model = 'whisper-large-v3' }) {
  const buf = await fs.readFile(mp3Path);
  const body = new FormData();
  body.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(mp3Path));
  body.append('model', model);
  body.append('response_format', 'json');

  let res;
  try {
    res = await fetchImpl(GROQ_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body });
  } catch (err) {
    throw new TranscribeError(messageFor(undefined, err.message), undefined, err);
  }

  let json = {};
  try { json = await res.json(); } catch { /* corpo não-JSON */ }

  if (!res.ok) {
    const detail = json?.error?.message || `HTTP ${res.status}`;
    throw new TranscribeError(messageFor(res.status, detail), res.status);
  }
  return typeof json.text === 'string' ? json.text : '';
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test`
Expected: todos PASS (4 de convert + 6 de transcribe).

- [ ] **Step 5: Commit**

```bash
git add src/transcribe.js test/transcribe.test.js
git commit -m "feat: cliente da API de transcrição da Groq"
```

---

### Task 3: Servidor Express com POST /transcribe

**Files:**
- Create: `server.js`
- Create: `tmp/.gitkeep`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `convertToMp3`, `ConversionError` de `src/convert.js`; `transcribe`, `TranscribeError` de `src/transcribe.js`.
- Produces: `createApp({ apiKey, convertFn = convertToMp3, transcribeFn = transcribe, tmpDir = 'tmp', maxUploadBytes = 200*1024*1024, maxMp3Bytes = 25*1024*1024 })` devolve um `express()` app. Quando o arquivo é executado diretamente (`node server.js`), carrega `.env`, cria o app e escuta na porta `PORT || 3000`.
- Produces: resposta de sucesso `{ text: string }`; resposta de erro `{ error: string }` com os códigos da spec.

- [ ] **Step 1: Escrever o teste que falha**

`test/server.test.js`:

```js
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
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test`
Expected: FAIL com `Cannot find module '../server.js'`.

- [ ] **Step 3: Implementar server.js e criar public/index.html mínimo**

`tmp/.gitkeep`: arquivo vazio (o `.gitignore` já tem `tmp/`; adicionar a exceção `!tmp/.gitkeep`).

`public/index.html` provisório (Task 4 substitui): `<!doctype html><html lang="pt-BR"><title>Transcritor</title><body>ok</body></html>`

`server.js`:

```js
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertToMp3, ConversionError } from './src/convert.js';
import { transcribe, TranscribeError } from './src/transcribe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MB = 1024 * 1024;

export function createApp({
  apiKey,
  convertFn = convertToMp3,
  transcribeFn = transcribe,
  tmpDir = path.join(__dirname, 'tmp'),
  maxUploadBytes = 200 * MB,
  maxMp3Bytes = 25 * MB,
} = {}) {
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));

  const upload = multer({ dest: tmpDir, limits: { fileSize: maxUploadBytes, files: 1 } }).single('audio');

  app.post('/transcribe', (req, res) => {
    upload(req, res, async (uploadErr) => {
      const inputPath = req.file?.path;
      const mp3Path = inputPath ? `${inputPath}.mp3` : null;
      try {
        if (uploadErr?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Arquivo acima de 200 MB.' });
        if (uploadErr || !req.file) return res.status(400).json({ error: 'Escolha um arquivo de áudio.' });
        if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY não encontrada no .env.' });

        await convertFn(inputPath, mp3Path);
        const { size } = await fs.stat(mp3Path);
        if (size > maxMp3Bytes) return res.status(413).json({ error: 'Áudio muito longo para o plano gratuito da Groq.' });

        const text = await transcribeFn(mp3Path, { apiKey });
        return res.json({ text });
      } catch (err) {
        if (err instanceof ConversionError) return res.status(422).json({ error: 'Não consegui ler esse arquivo como áudio.' });
        if (err instanceof TranscribeError) return res.status(502).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: 'Erro interno.' });
      } finally {
        await Promise.all([inputPath, mp3Path].filter(Boolean).map((p) => fs.rm(p, { force: true })));
      }
    });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) console.error('AVISO: GROQ_API_KEY não encontrada no .env.');
  const port = Number(process.env.PORT) || 3000;
  createApp({ apiKey }).listen(port, () => console.log(`Transcritor em http://localhost:${port}`));
}
```

Atualizar `.gitignore` para:

```
node_modules/
.env
tmp/*
!tmp/.gitkeep
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test`
Expected: todos PASS (4 + 6 + 9).

- [ ] **Step 5: Commit**

```bash
git add server.js public/index.html tmp/.gitkeep .gitignore test/server.test.js
git commit -m "feat: servidor Express com POST /transcribe"
```

---

### Task 4: Página web, README e teste manual

**Files:**
- Modify: `public/index.html` (substituir o provisório)
- Create: `README.md`

**Interfaces:**
- Consumes: `POST /transcribe` com campo multipart `audio`; sucesso `{ text }`, erro `{ error }`.

- [ ] **Step 1: Escrever public/index.html**

```html
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcritor de Áudio</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --fg:#1b1f24; --muted:#5f6b7a; --accent:#2563eb; --border:#d6dbe3; --err:#b42318; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --card:#181b22; --fg:#e8eaf0; --muted:#9aa4b2; --accent:#60a5fa; --border:#2a2f3a; --err:#f87171; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 1.5rem; margin: 0 0 16px; }
  #drop { border:2px dashed var(--border); border-radius:12px; padding:40px 16px; text-align:center; background:var(--card); cursor:pointer; transition:border-color .15s; }
  #drop.over { border-color: var(--accent); }
  #drop p { margin: 0; color: var(--muted); }
  #drop strong { color: var(--fg); }
  input[type=file] { display:none; }
  #status { margin:16px 0; min-height:1.5em; color:var(--muted); }
  #status.err { color: var(--err); }
  textarea { width:100%; min-height:260px; padding:12px; border:1px solid var(--border); border-radius:8px; background:var(--card); color:var(--fg); font:inherit; resize:vertical; }
  .actions { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
  button { padding:10px 16px; border:1px solid var(--border); border-radius:8px; background:var(--card); color:var(--fg); font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button:disabled { opacity:.5; cursor:not-allowed; }
</style>
</head>
<body>
<main>
  <h1>Transcritor de Áudio</h1>
  <label id="drop" for="file">
    <p><strong>Arraste um áudio aqui</strong> ou clique para escolher</p>
    <p>Qualquer formato: .opus do WhatsApp, .m4a, .mp3, .ogg, .wav, .caf, .amr...</p>
    <input id="file" type="file" accept="audio/*,.opus,.caf,.amr,.3gp,.wma,.aac,.ogg,.oga,.m4a,.mp3,.wav,.webm,.mp4,.flac">
  </label>
  <div id="status"></div>
  <textarea id="out" placeholder="A transcrição aparece aqui." readonly></textarea>
  <div class="actions">
    <button id="copy" class="primary" disabled>Copiar</button>
    <button id="download" disabled>Baixar .txt</button>
  </div>
</main>
<script>
  const drop = document.getElementById('drop');
  const input = document.getElementById('file');
  const status = document.getElementById('status');
  const out = document.getElementById('out');
  const copyBtn = document.getElementById('copy');
  const dlBtn = document.getElementById('download');
  let currentName = 'transcricao';

  function setStatus(msg, isErr = false) { status.textContent = msg; status.className = isErr ? 'err' : ''; }
  function setResult(text) {
    out.value = text;
    const has = text.trim().length > 0;
    copyBtn.disabled = !has; dlBtn.disabled = !has;
  }

  async function send(file) {
    if (!file) return;
    currentName = file.name.replace(/\.[^.]+$/, '') || 'transcricao';
    setResult('');
    setStatus(`Transcrevendo "${file.name}"...`);
    const body = new FormData();
    body.append('audio', file);
    try {
      const res = await fetch('/transcribe', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setStatus(data.error || `Erro ${res.status}.`, true); return; }
      if (!data.text || !data.text.trim()) { setStatus('Nenhuma fala detectada.'); return; }
      setResult(data.text);
      setStatus('Pronto.');
    } catch (err) {
      setStatus('Não consegui falar com o servidor local. Ele está rodando?', true);
    }
  }

  input.addEventListener('change', () => send(input.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => send(e.dataTransfer.files[0]));

  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(out.value);
    setStatus('Copiado.');
  });
  dlBtn.addEventListener('click', () => {
    const blob = new Blob([out.value], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${currentName}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
</script>
</body>
</html>
```

- [ ] **Step 2: Rodar os testes (a página provisória foi substituída, o teste de GET / deve seguir passando)**

Run: `npm test`
Expected: todos PASS.

- [ ] **Step 3: Escrever README.md**

```markdown
# Transcritor de Áudio

Página web local que transcreve qualquer áudio (inclusive `.opus` do WhatsApp)
usando a API gratuita da Groq (Whisper large-v3).

## Uso

1. Crie `.env` na raiz com `GROQ_API_KEY=sua_chave`.
2. `npm install`
3. `npm start`
4. Abra http://localhost:3000, arraste o áudio, copie ou baixe o texto.

## Limites do plano gratuito da Groq

8 horas de áudio por dia, 25 MB por envio (o app converte para MP3 leve antes
de enviar, então um áudio de 10 min fica em ~5 MB).

## Testes

`npm test`
```

- [ ] **Step 4: Teste manual com áudio real**

Run: `npm start` em um terminal. Abrir `http://localhost:3000`. Enviar um `.opus` do WhatsApp e um `.m4a` ou `.mp3`.
Expected: status "Transcrevendo..." seguido de "Pronto." e texto na caixa; Copiar e Baixar funcionam; pasta `tmp/` só com `.gitkeep` ao final. Enviar um arquivo `.txt` renomeado para `.opus` deve mostrar "Não consegui ler esse arquivo como áudio."

- [ ] **Step 5: Commit**

```bash
git add public/index.html README.md
git commit -m "feat: página web de transcrição e README"
```
