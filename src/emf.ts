import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

import { inkscapeProfileDir } from './paths';

const execFileP = promisify(execFile);

/**
 * Write a minimal Inkscape profile whose sole purpose is to flip two knobs on
 * the EMF output extension:
 *
 *   extensions > org.inkscape.output.emf > textToPath       (false → editable)
 *   extensions > org.inkscape.output.emf > FixPPTCharPos    (true  → Office glyph advance)
 *
 * These are not exposed via Inkscape's CLI — the only way to set them for a
 * batch export is preferences.xml. We point Inkscape at this dir via the
 * INKSCAPE_PROFILE_DIR env var so the user's real profile is untouched.
 *
 * Inkscape falls back to its compiled-in defaults for every key we don't list
 * here, so a minimal file is sufficient.
 */
async function ensureInkscapeProfile(textToPath: boolean): Promise<string> {
  const dir = inkscapeProfileDir();
  await fs.mkdir(dir, { recursive: true });
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
    `<inkscape version="1.0" xmlns="http://www.inkscape.org/namespaces/inkscape">\n` +
    `  <group id="extensions">\n` +
    `    <group id="org.inkscape.output.emf">\n` +
    `      <entry name="textToPath" value="${textToPath ? 'true' : 'false'}"/>\n` +
    `      <entry name="FixPPTCharPos" value="true"/>\n` +
    `    </group>\n` +
    `  </group>\n` +
    `</inkscape>\n`;
  await fs.writeFile(path.join(dir, 'preferences.xml'), xml, 'utf8');
  return dir;
}

const DEFAULT_INSTALL_PATHS = [
  'C:/Program Files/Inkscape/bin/inkscape.exe',
  'C:/Program Files (x86)/Inkscape/bin/inkscape.exe',
];

export async function detectInkscape(override?: string | null): Promise<string | null> {
  const candidates: string[] = [];

  if (override) candidates.push(override);
  if (process.env.MERMAID_PASTE_INKSCAPE) candidates.push(process.env.MERMAID_PASTE_INKSCAPE);

  for (const c of candidates) {
    if (await isExecutable(c)) return c;
  }

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileP('where', ['inkscape'], { windowsHide: true });
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first && (await isExecutable(first))) return first;
    } catch {
      /* not on PATH */
    }
    for (const p of DEFAULT_INSTALL_PATHS) {
      if (await isExecutable(p)) return p;
    }
  } else {
    try {
      const { stdout } = await execFileP('which', ['inkscape']);
      const first = stdout.trim();
      if (first && (await isExecutable(first))) return first;
    } catch {
      /* not on PATH */
    }
  }

  return null;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

export interface SvgToEmfOptions {
  inkscapePath: string;
  textToPath?: boolean;
}

/**
 * Converts an SVG string to an EMF file via Inkscape CLI. Returns path to the
 * temporary EMF, or null on failure. Caller is responsible for cleanup.
 */
export async function svgToEmf(svg: string, opts: SvgToEmfOptions): Promise<string | null> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mermaid-paste-'));
  const inPath = path.join(tmp, 'in.svg');
  const outPath = path.join(tmp, 'out.emf');
  await fs.writeFile(inPath, svg, 'utf8');

  const textToPath = !!opts.textToPath;
  const profileDir = await ensureInkscapeProfile(textToPath);

  const args = [
    inPath,
    '--export-type=emf',
    `--export-filename=${outPath}`,
    // Inkscape's general `--export-text-to-path` flag and the EMF writer's
    // private `textToPath` preference are two independent settings; the EMF
    // writer (emf-inout.cpp) reads ONLY its own extension parameter. We set
    // both to the same value so there's no ambiguity.
    `--export-text-to-path=${textToPath ? 'true' : 'false'}`,
  ];

  try {
    await execFileP(opts.inkscapePath, args, {
      windowsHide: true,
      timeout: 30_000,
      env: {
        ...process.env,
        // Route Inkscape's preferences.xml lookup to our isolated profile so
        // the EMF writer picks up our textToPath=false override. Without this,
        // the extension falls back to whatever the user (or the installer) has
        // saved — typically the buggy "Convert texts to paths" default that
        // produces unseletable, non-editable glyph outlines in Office.
        INKSCAPE_PROFILE_DIR: profileDir,
      },
    });
    const stat = await fs.stat(outPath).catch(() => null);
    if (!stat || stat.size === 0) return null;
    return outPath;
  } catch (err) {
    console.error('[emf] Inkscape failed:', err);
    return null;
  }
}
