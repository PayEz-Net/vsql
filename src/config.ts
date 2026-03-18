import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface Profile {
  host?: string;
  key?: string;
}

type ConfigFile = Record<string, Profile>;

const CONFIG_DIR = join(homedir(), '.vsql');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

function readConfig(): ConfigFile {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(config: ConfigFile): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export function getProfile(name: string = 'default'): Profile {
  return readConfig()[name] ?? {};
}

export function setProfileValue(key: 'host' | 'key', value: string, profile: string = 'default'): void {
  const config = readConfig();
  config[profile] = config[profile] ?? {};
  config[profile][key] = value;
  writeConfig(config);
}

export function clearConfig(): void {
  writeConfig({});
}

export function showConfig(): void {
  const config = readConfig();
  if (Object.keys(config).length === 0) {
    console.log('No config found. Run `vsql config init` to set up.');
    return;
  }
  for (const [name, profile] of Object.entries(config)) {
    console.log(`[${name}]`);
    if (profile.host) console.log(`  host: ${profile.host}`);
    if (profile.key) {
      const masked = profile.key.length > 12
        ? profile.key.slice(0, 9) + '***' + profile.key.slice(-6)
        : '***';
      console.log(`  key:  ${masked}`);
    }
  }
}

export function resolveConnection(flags: { host?: string; key?: string; profile?: string }): { host: string; key: string } {
  const profile = getProfile(flags.profile ?? 'default');
  const host = flags.host ?? process.env.VIBESQL_HOST ?? profile.host ?? 'http://localhost:52411';
  const key = flags.key ?? process.env.VIBESQL_KEY ?? profile.key;
  if (!key) {
    process.stderr.write('Error [NO_KEY]: No API key configured.\n');
    process.stderr.write('  Hint: Run `vsql config init` or pass --key.\n');
    process.exit(1);
  }
  return { host, key };
}
