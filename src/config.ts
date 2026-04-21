import { promises as fs } from 'fs';
import { AppConfig } from './types';
import { configFilePath, dataDir } from './paths';

const DEFAULTS: AppConfig = {
  enabled: true,
  hotkey: 'CommandOrControl+Shift+V',
  scale: 3,
  theme: 'default',
  emitEmf: false,
  autoPaste: false,
  textToPath: false,
  inkscapePath: null,
  autoFlipDirection: true,
  flipRatio: 2.0,
  emfUsePlainText: true,
  emitVisioSvg: true,
};

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(configFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(configFilePath(), JSON.stringify(cfg, null, 2), 'utf8');
}

export function defaultConfig(): AppConfig {
  return { ...DEFAULTS };
}
