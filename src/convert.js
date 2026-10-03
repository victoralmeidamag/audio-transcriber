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
