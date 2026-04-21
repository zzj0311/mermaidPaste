import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import { app, clipboard, nativeImage } from 'electron';

const execFileP = promisify(execFile);

/**
 * Resolves the clipboard helper script path in both dev and packaged builds.
 * In dev the script lives under `resources/` at the repo root; in a packaged
 * build electron-builder copies it into process.resourcesPath/resources/.
 */
function helperScriptPath(): string {
  const filename = 'set-clipboard.ps1';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', filename);
  }
  return path.join(app.getAppPath(), 'resources', filename);
}

export interface SetClipboardArgs {
  emfPath: string | null;
  pngPath: string;
  /**
   * Optional path to an SVG file. When supplied, the helper also registers
   * CF_HDROP (so Visio accepts it as a file drop on paste) and a registered
   * "image/svg+xml" clipboard format. Ignored on non-Windows platforms.
   */
  svgFilePath?: string | null;
}

/**
 * Places EMF + SVG-file + PNG on the Windows clipboard atomically (EMF first
 * so Office prefers it, SVG file drop for Visio, PNG/DIB as the universal
 * fallback).
 *
 * On non-Windows platforms the EMF/SVG steps are skipped; we just copy the
 * PNG via Electron's own clipboard API so developers can smoke-test on
 * Linux/mac.
 */
export async function setClipboard({
  emfPath,
  pngPath,
  svgFilePath,
}: SetClipboardArgs): Promise<void> {
  if (process.platform !== 'win32') {
    const img = nativeImage.createFromPath(pngPath);
    clipboard.writeImage(img);
    return;
  }

  const script = helperScriptPath();
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Png',
    pngPath,
  ];
  if (emfPath) {
    args.push('-Emf', emfPath);
  }
  if (svgFilePath) {
    args.push('-SvgPath', svgFilePath);
  }

  await execFileP('powershell.exe', args, {
    windowsHide: true,
    timeout: 15_000,
  });
}

/**
 * Writes a buffer to a freshly-created temp file and returns its absolute path.
 */
export async function writeTmp(data: Uint8Array | Buffer, extension: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'mermaid-paste-'));
  const full = path.join(dir, `clip${extension}`);
  await fs.writeFile(full, Buffer.from(data));
  return full;
}
