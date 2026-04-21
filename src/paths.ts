import { app } from 'electron';
import * as path from 'path';

/**
 * Base directory for all app data (config + logs). Kept separate from Electron's
 * default `userData` location so the folder name matches our project slug,
 * regardless of the productName used in packaging metadata.
 */
export function dataDir(): string {
  return path.join(app.getPath('appData'), 'mermaid-paste');
}

export function configFilePath(): string {
  return path.join(dataDir(), 'config.json');
}

/**
 * Directory where the most recent render's artifacts are written so the user
 * can inspect them from the tray (Debug -> Open last render folder).
 */
export function lastRenderDir(): string {
  return path.join(dataDir(), 'last');
}

/**
 * Isolated Inkscape profile directory. We override a small number of
 * extension settings here (notably the EMF writer's `textToPath` flag) without
 * touching the user's real Inkscape config.
 */
export function inkscapeProfileDir(): string {
  return path.join(dataDir(), 'inkscape-profile');
}
