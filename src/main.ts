import {
  app,
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  Notification,
  Tray,
  clipboard,
  dialog,
  globalShortcut,
  nativeImage,
  shell,
} from 'electron';
import * as path from 'path';

import { promises as fs } from 'fs';

import { AppConfig, MermaidTheme, RenderResponse } from './types';
import { loadConfig, saveConfig } from './config';
import { dataDir, lastRenderDir } from './paths';
import { detectInkscape, svgToEmf } from './emf';
import { setClipboard, writeTmp } from './clipboard';
import { sendPasteKeystroke } from './autopaste';
import { initLogger, log, logFilePath } from './logger';
import { flipDirection, isTooWide } from './mermaidSource';

let tray: Tray | null = null;
let worker: BrowserWindow | null = null;
let workerReady = false;
let workerReadyPromise: Promise<void> | null = null;
let config: AppConfig;
let inkscapePath: string | null = null;
let inkscapeWarned = false;
let lastStatus = 'idle';

const SCALES: AppConfig['scale'][] = [2, 3, 4];
const THEMES: MermaidTheme[] = ['default', 'dark', 'neutral', 'forest'];

const DEMO_MERMAID = `flowchart LR
  A[Hotkey pressed] --> B{Mermaid valid?}
  B -- yes --> C[Render SVG]
  C --> D[Canvas -> PNG]
  C --> E[Inkscape -> EMF]
  D --> F[Clipboard]
  E --> F
  B -- no --> G[Leave clipboard alone]`;

/* ------------------------------------------------------------------ */
/* Single-instance guard                                               */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

process.on('uncaughtException', (err) => {
  try {
    log.error('uncaughtException', err);
  } catch {
    /* logger may not be ready yet */
  }
});

process.on('unhandledRejection', (err) => {
  try {
    log.error('unhandledRejection', err);
  } catch {
    /* logger may not be ready yet */
  }
});

app.whenReady().then(async () => {
  const logPath = await initLogger();

  if (process.platform === 'darwin') app.dock?.hide();

  log.info('app ready', { logPath, appPath: app.getAppPath(), resourcesPath: process.resourcesPath });

  config = await loadConfig();
  log.info('config loaded', config);

  inkscapePath = await detectInkscape(config.inkscapePath);
  log.info('inkscape path', { inkscapePath });

  await createWorker();
  createTray();
  registerHotkey();

  if (config.emitEmf && !inkscapePath) {
    warnInkscapeMissingOnce();
  }

  setStatus('ready');
});

app.on('window-all-closed', () => {
  // Tray app: do not quit when the hidden window closes.
});

app.on('will-quit', () => {
  log.info('will-quit, unregistering shortcuts');
  globalShortcut.unregisterAll();
});

/* ------------------------------------------------------------------ */
/* Hidden renderer BrowserWindow                                       */
/* ------------------------------------------------------------------ */

async function createWorker(): Promise<void> {
  const htmlPath = path.join(__dirname, 'renderer', 'index.html');
  log.info('creating worker', { htmlPath });

  workerReady = false;
  worker = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const wc = worker.webContents;

  wc.on('console-message', (_e, level, message, line, sourceId) => {
    const label = ['debug', 'info', 'warn', 'error'][level] ?? 'info';
    log.debug(`[renderer:${label}]`, `${message} (${sourceId}:${line})`);
  });
  wc.on('render-process-gone', (_e, details) => {
    log.error('[renderer] render-process-gone', details);
    workerReady = false;
  });
  wc.on('preload-error', (_e, preloadPath, error) => {
    log.error('[renderer] preload-error', { preloadPath, error });
  });
  wc.on('did-fail-load', (_e, code, description, url) => {
    log.error('[renderer] did-fail-load', { code, description, url });
  });

  workerReadyPromise = new Promise<void>((resolve) => {
    wc.once('did-finish-load', () => {
      log.info('[renderer] did-finish-load');
      workerReady = true;
      resolve();
    });
  });

  await worker.loadFile(htmlPath);
  await workerReadyPromise;

  // Sanity check: make sure the bundled IIFE defined our entry point.
  try {
    const ok = (await wc.executeJavaScript(
      'typeof window.renderMermaid === "function"',
      true
    )) as boolean;
    log.info('[renderer] renderMermaid present?', ok);
    if (!ok) setStatus('renderer did not expose renderMermaid');
  } catch (e) {
    log.error('[renderer] sanity check failed', e);
  }
}

/* ------------------------------------------------------------------ */
/* Tray + menu                                                         */
/* ------------------------------------------------------------------ */

function trayIconPath(): string {
  const rel = 'assets/tray.png';
  if (app.isPackaged) return path.join(process.resourcesPath, rel);
  return path.join(app.getAppPath(), rel);
}

function createTray(): void {
  let icon = nativeImage.createFromPath(trayIconPath());
  if (icon.isEmpty()) {
    icon = nativeImage.createFromBuffer(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64'
      )
    );
  }
  tray = new Tray(icon);
  tray.setToolTip('Mermaid Paste');
  rebuildTrayMenu();
}

function rebuildTrayMenu(): void {
  if (!tray) return;

  const scaleItems: MenuItemConstructorOptions[] = SCALES.map((s) => ({
    label: `${s}x`,
    type: 'radio',
    checked: config.scale === s,
    click: () => updateConfig({ scale: s }),
  }));

  const themeItems: MenuItemConstructorOptions[] = THEMES.map((t) => ({
    label: t,
    type: 'radio',
    checked: config.theme === t,
    click: () => updateConfig({ theme: t }),
  }));

  const template: MenuItemConstructorOptions[] = [
    { label: `Status: ${lastStatus}`, enabled: false },
    {
      label: config.enabled ? 'Enabled (click to disable)' : 'Disabled (click to enable)',
      click: () => updateConfig({ enabled: !config.enabled }),
    },
    { type: 'separator' },
    { label: `Hotkey: ${config.hotkey}`, click: promptHotkey },
    { label: 'Scale', submenu: scaleItems },
    { label: 'Theme', submenu: themeItems },
    {
      label: 'Emit Visio-friendly SVG (file drop for Visio)',
      type: 'checkbox',
      checked: config.emitVisioSvg,
      click: () => updateConfig({ emitVisioSvg: !config.emitVisioSvg }),
    },
    {
      label: 'Emit EMF via Inkscape (opt-in; barely editable in Office)',
      type: 'checkbox',
      checked: config.emitEmf,
      click: () => updateConfig({ emitEmf: !config.emitEmf }),
    },
    {
      label: 'Plain SVG text for EMF (fixes missing text in Word)',
      type: 'checkbox',
      checked: config.emfUsePlainText,
      click: () => updateConfig({ emfUsePlainText: !config.emfUsePlainText }),
    },
    {
      label: 'Convert text to paths (for exotic fonts)',
      type: 'checkbox',
      checked: config.textToPath,
      click: () => updateConfig({ textToPath: !config.textToPath }),
    },
    {
      label: `Auto-flip LR\u2194TB when width > ${config.flipRatio}\u00d7 height`,
      type: 'checkbox',
      checked: config.autoFlipDirection,
      click: () => updateConfig({ autoFlipDirection: !config.autoFlipDirection }),
    },
    {
      label: 'Auto-paste after hotkey',
      type: 'checkbox',
      checked: config.autoPaste,
      click: () => updateConfig({ autoPaste: !config.autoPaste }),
    },
    { type: 'separator' },
    {
      label: inkscapePath ? `Inkscape: ${inkscapePath}` : 'Inkscape: not found',
      enabled: false,
    },
    { label: 'Set Inkscape path...', click: promptInkscapePath },
    { label: 'Re-detect Inkscape', click: reDetectInkscape },
    { label: 'Download Inkscape', click: () => shell.openExternal('https://inkscape.org/release/') },
    { type: 'separator' },
    { label: 'Debug', submenu: debugSubmenu() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(`Mermaid Paste — ${config.enabled ? 'on' : 'off'} (${config.hotkey})`);
}

function debugSubmenu(): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Open log file',
      click: async () => {
        const p = logFilePath();
        log.info('opening log file', p);
        const err = await shell.openPath(p);
        if (err) log.warn('openPath(log) returned', err);
      },
    },
    {
      label: 'Open config folder',
      click: async () => {
        const err = await shell.openPath(dataDir());
        if (err) log.warn('openPath(dataDir) returned', err);
      },
    },
    {
      label: 'Open last render folder (input.mmd, rendered.svg/png/emf/visio.svg)',
      click: async () => {
        const dir = lastRenderDir();
        try {
          await fs.mkdir(dir, { recursive: true });
        } catch {
          /* best effort */
        }
        const err = await shell.openPath(dir);
        if (err) log.warn('openPath(lastRenderDir) returned', err);
      },
    },
    {
      label: 'Show worker DevTools',
      click: () => {
        if (!worker || worker.isDestroyed()) {
          log.warn('devtools: no worker');
          return;
        }
        worker.webContents.openDevTools({ mode: 'detach' });
      },
    },
    {
      label: 'Show worker window (live)',
      click: () => {
        if (!worker || worker.isDestroyed()) {
          log.warn('show-worker: no worker');
          return;
        }
        worker.show();
        worker.focus();
      },
    },
    {
      label: 'Hide worker window',
      click: () => {
        if (worker && !worker.isDestroyed()) worker.hide();
      },
    },
    { type: 'separator' },
    {
      label: 'Test render (built-in diagram, ignores clipboard)',
      click: () => void runPipeline(DEMO_MERMAID, { source: 'test-render' }),
    },
    {
      label: 'Test render from clipboard (same as hotkey)',
      click: () => void handleHotkey('manual'),
    },
    {
      label: 'Reload worker',
      click: async () => {
        log.info('manual worker reload requested');
        if (worker && !worker.isDestroyed()) {
          worker.destroy();
          worker = null;
        }
        await createWorker();
        toast('Worker reloaded');
      },
    },
    {
      label: 'Re-register hotkey',
      click: () => {
        registerHotkey();
        toast('Hotkey re-registered');
      },
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Hotkey                                                              */
/* ------------------------------------------------------------------ */

function registerHotkey(): void {
  globalShortcut.unregisterAll();
  if (!config.enabled) {
    log.info('hotkey not registered (disabled)');
    setStatus('disabled');
    return;
  }

  const ok = globalShortcut.register(config.hotkey, () => void handleHotkey('hotkey'));
  if (!ok) {
    log.error('hotkey registration failed', { hotkey: config.hotkey });
    setStatus(`hotkey ${config.hotkey} unavailable`);
    new Notification({
      title: 'Mermaid Paste',
      body: `Could not register hotkey ${config.hotkey}. It may be in use by another app. Open the tray menu to pick a different one.`,
    }).show();
  } else {
    log.info('hotkey registered', config.hotkey);
    setStatus(`listening on ${config.hotkey}`);
  }
}

async function handleHotkey(source: 'hotkey' | 'manual'): Promise<void> {
  log.info('hotkey fired', { source });
  const code = clipboard.readText().trim();
  if (!code) {
    setStatus('clipboard had no text');
    toast('Clipboard has no text to render.');
    return;
  }
  log.info('clipboard read', { length: code.length, firstLine: code.split('\n', 1)[0] });
  await runPipeline(code, { source });
}

interface RunContext {
  source: 'hotkey' | 'manual' | 'test-render';
}

async function runPipeline(code: string, ctx: RunContext): Promise<void> {
  const debugDir = lastRenderDir();
  try {
    await fs.mkdir(debugDir, { recursive: true });
    await fs.writeFile(path.join(debugDir, 'input.mmd'), code, 'utf8');
  } catch (e) {
    log.warn('could not write debug input', e);
  }

  try {
    if (!worker || worker.isDestroyed() || !workerReady) {
      log.info('worker not ready, (re)creating');
      await createWorker();
    }

    setStatus('rendering…');
    let sourceUsed = code;
    let res = await callRenderer(code);
    if ('error' in res) {
      log.warn('render error', { error: res.error, svgBytes: res.svg?.length });
      if (res.svg) {
        try {
          await fs.writeFile(path.join(debugDir, 'rendered.svg'), res.svg, 'utf8');
          log.info('wrote failing SVG to', path.join(debugDir, 'rendered.svg'));
        } catch (e) {
          log.warn('could not persist failing SVG', e);
        }
      }
      setStatus(`render error: ${res.error.split('\n')[0]}`);
      toast('Render error — see log. Debug -> Open last render folder.');
      return;
    }

    log.info('render ok', {
      width: res.width,
      height: res.height,
      svgBytes: res.svg.length,
    });

    // Auto-flip direction if the first render came back much wider than tall.
    // Re-render with LR->TB / RL->BT and keep whichever aspect ratio is closer
    // to square (the flipped version may itself end up too tall).
    if (
      config.autoFlipDirection &&
      isTooWide(res.width, res.height, config.flipRatio)
    ) {
      const flipped = flipDirection(code);
      if (flipped && flipped !== code) {
        log.info('auto-flip: first render too wide, retrying with flipped direction', {
          width: res.width,
          height: res.height,
          ratio: +(res.width / res.height).toFixed(2),
          threshold: config.flipRatio,
        });
        try {
          await fs.writeFile(path.join(debugDir, 'input.flipped.mmd'), flipped, 'utf8');
        } catch (e) {
          log.warn('could not write flipped input', e);
        }
        setStatus('rendering (flipped)…');
        const flippedRes = await callRenderer(flipped);
        if ('error' in flippedRes) {
          log.warn('flipped render failed, falling back to original', {
            error: flippedRes.error,
          });
        } else {
          const origAr = Math.max(res.width / res.height, res.height / res.width);
          const flipAr = Math.max(
            flippedRes.width / flippedRes.height,
            flippedRes.height / flippedRes.width
          );
          log.info('auto-flip: comparing aspect ratios', {
            original: +origAr.toFixed(2),
            flipped: +flipAr.toFixed(2),
            pickedFlipped: flipAr < origAr,
          });
          if (flipAr < origAr) {
            res = flippedRes;
            sourceUsed = flipped;
            setStatus('rendered (flipped)');
          } else {
            log.info('auto-flip: flipped version not an improvement, keeping original');
            setStatus('rendered');
          }
        }
      } else {
        log.info('auto-flip: no flippable direction found in source');
      }
    }

    try {
      await fs.writeFile(path.join(debugDir, 'rendered.svg'), res.svg, 'utf8');
    } catch (e) {
      log.warn('could not persist rendered.svg', e);
    }

    setStatus('capturing page…');
    const pngBuffer = await capturePng(res.width, res.height);
    log.info('page captured', { bytes: pngBuffer.length });

    try {
      await fs.writeFile(path.join(debugDir, 'rendered.png'), pngBuffer);
    } catch (e) {
      log.warn('could not persist rendered.png', e);
    }

    const pngPath = await writeTmp(pngBuffer, '.png');
    log.info('png written', pngPath);

    let visioSvgPath: string | null = null;
    if (config.emitVisioSvg) {
      setStatus('flattening SVG for Visio…');
      log.info('visio: requesting flattened SVG');
      const visio = await callRenderer(sourceUsed, {
        htmlLabels: false,
        skipDomInject: true,
        inlineStyles: true,
        flattenForVisio: true,
      });
      if ('error' in visio) {
        log.warn('visio-flatten render failed, skipping SVG file drop', {
          error: visio.error,
        });
      } else {
        try {
          const debugPath = path.join(debugDir, 'rendered.visio.svg');
          await fs.writeFile(debugPath, visio.svg, 'utf8');
          log.info('wrote flattened Visio SVG', {
            bytes: visio.svg.length,
            path: debugPath,
          });
        } catch (e) {
          log.warn('could not persist rendered.visio.svg', e);
        }
        try {
          // Visio's file drop uses the on-disk filename in its layer/object
          // names after paste, so give the temp file a meaningful stem.
          visioSvgPath = await writeTmp(Buffer.from(visio.svg, 'utf8'), '.svg');
          // Rename clip.svg -> mermaid.svg so Visio displays a nicer label.
          const niceName = path.join(path.dirname(visioSvgPath), 'mermaid.svg');
          try {
            await fs.rename(visioSvgPath, niceName);
            visioSvgPath = niceName;
          } catch (e) {
            log.warn('could not rename visio svg temp file', e);
          }
          log.info('visio svg file ready', visioSvgPath);
        } catch (e) {
          log.warn('could not materialise visio svg temp file', e);
          visioSvgPath = null;
        }
      }
    }

    let emfPath: string | null = null;
    if (config.emitEmf && inkscapePath) {
      // Inkscape's EMF exporter silently drops <foreignObject> content, which
      // is what mermaid uses for flowchart labels by default — you get shapes
      // with no text. Re-render with `htmlLabels: false` so mermaid emits
      // native SVG <text> that Inkscape converts cleanly.
      let svgForEmf = res.svg;
      if (config.emfUsePlainText) {
        setStatus('re-rendering for EMF…');
        log.info('emf: requesting plain-text SVG (htmlLabels=false)');
        const plain = await callRenderer(sourceUsed, {
          htmlLabels: false,
          skipDomInject: true,
          inlineStyles: true,
        });
        if ('error' in plain) {
          log.warn('plain-text render failed, falling back to htmlLabels=true SVG for EMF', {
            error: plain.error,
          });
        } else {
          svgForEmf = plain.svg;
          try {
            await fs.writeFile(path.join(debugDir, 'rendered.plaintext.svg'), plain.svg, 'utf8');
          } catch (e) {
            log.warn('could not persist plain-text SVG', e);
          }
        }
      }

      setStatus('Inkscape → EMF…');
      emfPath = await svgToEmf(svgForEmf, {
        inkscapePath,
        textToPath: config.textToPath,
      });
      log.info('emf produced', { emfPath });
      if (emfPath) {
        try {
          await fs.copyFile(emfPath, path.join(debugDir, 'rendered.emf'));
        } catch (e) {
          log.warn('could not copy EMF to debug dir', e);
        }
      } else {
        log.warn('Inkscape failed; falling back to PNG-only');
      }
    } else if (config.emitEmf && !inkscapePath) {
      warnInkscapeMissingOnce();
    }

    setStatus('writing clipboard…');
    await setClipboard({ emfPath, pngPath, svgFilePath: visioSvgPath });
    log.info('clipboard set');

    const parts: string[] = [];
    if (emfPath) parts.push('EMF');
    if (visioSvgPath) parts.push('SVG file');
    parts.push('PNG');
    const fmt = parts.join(' + ');
    setStatus(`done (${fmt}, ${res.width}×${res.height}, from ${ctx.source})`);
    toast(`Clipboard: ${fmt} (${res.width}×${res.height}). Ctrl+V to paste.`);

    if (config.autoPaste && ctx.source !== 'test-render') {
      log.info('auto-pasting');
      setTimeout(() => void sendPasteKeystroke(), 80);
    }
  } catch (err) {
    log.error('pipeline failed', err);
    setStatus(`error: ${(err as Error).message ?? err}`);
    toast(`Pipeline failed: ${(err as Error).message ?? err}`);
  }
}

interface RendererOptions {
  htmlLabels?: boolean;
  skipDomInject?: boolean;
  inlineStyles?: boolean;
  flattenForVisio?: boolean;
}

async function callRenderer(
  code: string,
  opts: RendererOptions = {}
): Promise<RenderResponse> {
  if (!worker) throw new Error('worker not ready');
  const payload = {
    code,
    scale: config.scale,
    theme: config.theme,
    ...opts,
  };
  const js = `window.renderMermaid(${JSON.stringify(payload)})`;
  return (await worker.webContents.executeJavaScript(js, true)) as RenderResponse;
}

/**
 * Captures the worker window's currently-rendered page as a PNG buffer. The
 * renderer page has already been laid out at the target pixel dimensions by
 * `renderMermaid`; we only need to resize the window to match and ask Electron
 * to snapshot it.
 *
 * Using `webContents.capturePage` instead of <img>+canvas.toBlob side-steps the
 * canvas-taint rule that Chromium applies to SVGs referencing any cross-origin
 * content (including @font-face URLs and foreignObject HTML).
 */
async function capturePng(width: number, height: number): Promise<Buffer> {
  if (!worker || worker.isDestroyed()) throw new Error('worker not ready for capture');

  worker.setContentSize(width, height);
  // Give the compositor at least one frame to pick up the new size + layout.
  await new Promise((r) => setTimeout(r, 60));

  const image = await worker.webContents.capturePage({ x: 0, y: 0, width, height });
  const size = image.getSize();
  log.info('capturePage returned', { requested: { width, height }, got: size });
  if (size.width !== width || size.height !== height) {
    log.warn(
      `capturePage returned ${size.width}x${size.height} for a ${width}x${height} request (likely system DPR scaling).`
    );
  }

  const buf = image.toPNG();

  // Blank the DOM so the next render starts from a clean stage.
  try {
    await worker.webContents.executeJavaScript('window.clearStage && window.clearStage()', true);
  } catch (e) {
    log.warn('clearStage failed', e);
  }

  return buf;
}

/* ------------------------------------------------------------------ */
/* Config mutators                                                     */
/* ------------------------------------------------------------------ */

async function updateConfig(patch: Partial<AppConfig>): Promise<void> {
  const prev = config;
  config = { ...prev, ...patch };
  log.info('config patched', patch);
  await saveConfig(config);

  if (patch.hotkey !== undefined || patch.enabled !== undefined) {
    registerHotkey();
  }
  if (patch.inkscapePath !== undefined) {
    inkscapePath = await detectInkscape(config.inkscapePath);
    inkscapeWarned = false;
  }
  rebuildTrayMenu();
}

async function promptHotkey(): Promise<void> {
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'question',
    title: 'Change hotkey',
    message: `Current hotkey: ${config.hotkey}\n\nPick a preset:`,
    buttons: [
      'CommandOrControl+Shift+V',
      'CommandOrControl+Alt+V',
      'CommandOrControl+Shift+M',
      'Cancel',
    ],
    cancelId: 3,
    defaultId: 0,
    checkboxLabel: 'Keep current',
    checkboxChecked: false,
  });
  if (checkboxChecked || response === 3) return;
  const presets = [
    'CommandOrControl+Shift+V',
    'CommandOrControl+Alt+V',
    'CommandOrControl+Shift+M',
  ];
  await updateConfig({ hotkey: presets[response] });
}

async function promptInkscapePath(): Promise<void> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select inkscape executable',
    properties: ['openFile'],
    filters: [{ name: 'Inkscape', extensions: ['exe', ''] }],
  });
  if (canceled || filePaths.length === 0) return;
  await updateConfig({ inkscapePath: filePaths[0] });
}

async function reDetectInkscape(): Promise<void> {
  inkscapePath = await detectInkscape(config.inkscapePath);
  inkscapeWarned = false;
  rebuildTrayMenu();
  toast(inkscapePath ? `Found Inkscape at ${inkscapePath}` : 'Inkscape not found.');
}

function warnInkscapeMissingOnce(): void {
  if (inkscapeWarned) return;
  inkscapeWarned = true;
  log.warn('inkscape missing; PNG-only mode');
  toast(
    'Inkscape was not found. Running in PNG-only mode. ' +
      'Install Inkscape to paste editable vector shapes in Office.'
  );
}

/* ------------------------------------------------------------------ */
/* Status helpers                                                      */
/* ------------------------------------------------------------------ */

function setStatus(s: string): void {
  lastStatus = s;
  log.info('status', s);
  if (tray) {
    tray.setToolTip(`Mermaid Paste — ${s}`);
    rebuildTrayMenu();
  }
}

function toast(body: string, title = 'Mermaid Paste'): void {
  try {
    new Notification({ title, body }).show();
  } catch (e) {
    log.warn('toast failed', e);
  }
}
