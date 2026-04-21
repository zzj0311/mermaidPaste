import { app } from 'electron';
import { promises as fs, createWriteStream, WriteStream } from 'fs';
import * as path from 'path';

import { dataDir } from './paths';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

let stream: WriteStream | null = null;
let currentFile = '';

function ts(): string {
  return new Date().toISOString();
}

function formatArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ''}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function write(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', args: unknown[]): void {
  const line = `[${ts()}] [${level}] ${args.map(formatArg).join(' ')}`;
  if (stream) stream.write(line + '\n');
  // Electron on Windows hides stdout when launched without a console, but keep
  // mirroring anyway for devs who run `npm start` or attach via --inspect.
  const method = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
  (console as unknown as Record<string, (s: string) => void>)[method](line);
}

export async function initLogger(): Promise<string> {
  const dir = path.join(dataDir(), 'logs');
  await fs.mkdir(dir, { recursive: true });

  currentFile = path.join(dir, 'main.log');
  try {
    const s = await fs.stat(currentFile);
    if (s.size > MAX_LOG_BYTES) {
      const rotated = path.join(dir, 'main.prev.log');
      await fs.rm(rotated, { force: true });
      await fs.rename(currentFile, rotated);
    }
  } catch {
    /* no existing log yet */
  }

  stream = createWriteStream(currentFile, { flags: 'a' });
  stream.write(
    `\n===== Started ${ts()} pid=${process.pid} version=${app.getVersion()} ` +
      `packaged=${app.isPackaged} platform=${process.platform} =====\n`
  );
  return currentFile;
}

export function logFilePath(): string {
  return currentFile;
}

export const log = {
  info: (...a: unknown[]): void => write('INFO', a),
  warn: (...a: unknown[]): void => write('WARN', a),
  error: (...a: unknown[]): void => write('ERROR', a),
  debug: (...a: unknown[]): void => write('DEBUG', a),
};
