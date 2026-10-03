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

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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
      let status = 200;
      let body;
      try {
        if (uploadErr?.code === 'LIMIT_FILE_SIZE') throw new HttpError(413, `Arquivo acima de ${Math.round(maxUploadBytes / MB)} MB.`);
        if (uploadErr || !req.file) throw new HttpError(400, 'Escolha um arquivo de áudio.');
        if (!apiKey) throw new HttpError(500, 'GROQ_API_KEY não encontrada no .env.');

        await convertFn(inputPath, mp3Path);
        const { size } = await fs.stat(mp3Path);
        if (size > maxMp3Bytes) throw new HttpError(413, 'Áudio muito longo para o plano gratuito da Groq.');

        body = { text: await transcribeFn(mp3Path, { apiKey }) };
      } catch (err) {
        if (err instanceof HttpError) { status = err.status; body = { error: err.message }; }
        else if (err instanceof ConversionError) { status = 422; body = { error: 'Não consegui ler esse arquivo como áudio.' }; }
        else if (err instanceof TranscribeError) { status = 502; body = { error: err.message }; }
        else { console.error(err); status = 500; body = { error: 'Erro interno.' }; }
      } finally {
        // Limpa ANTES de responder, para o cliente nunca ver arquivo temporário sobrando.
        await Promise.all([inputPath, mp3Path].filter(Boolean)
          .map((p) => fs.rm(p, { force: true }).catch((e) => console.error('Falha ao apagar temporário', p, e.message))));
      }
      res.status(status).json(body);
    });
  });

  return app;
}

/** Sobe o servidor escutando SOMENTE em 127.0.0.1 (app local, nunca exposto à rede). */
export function startServer({ port = 3000, host = '127.0.0.1', log = console.log, ...appOpts } = {}) {
  return new Promise((resolve) => {
    const server = createApp(appOpts).listen(port, host, () => {
      log(`Transcritor em http://localhost:${server.address().port}`);
      resolve(server);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) console.error('AVISO: GROQ_API_KEY não encontrada no .env.');
  startServer({ port: Number(process.env.PORT) || 3000, apiKey });
}
