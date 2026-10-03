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
  if (status === 413) return 'A Groq recusou o arquivo por tamanho.';
  if (status === 429) return 'Limite da Groq atingido. Tente mais tarde.';
  if (status >= 500) return 'A Groq está indisponível no momento. Tente de novo em instantes.';
  return `Erro ao falar com a Groq: ${detail}`;
}

/**
 * Envia um MP3 à Groq e devolve o texto transcrito.
 * Lança TranscribeError com mensagem em português.
 */
export async function transcribe(mp3Path, { apiKey, fetchImpl = fetch, model = 'whisper-large-v3', timeoutMs = 120_000 }) {
  const buf = await fs.readFile(mp3Path);
  const body = new FormData();
  body.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(mp3Path));
  body.append('model', model);
  body.append('response_format', 'json');

  let res;
  try {
    res = await fetchImpl(GROQ_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body,
      signal: AbortSignal.timeout(timeoutMs) });
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
