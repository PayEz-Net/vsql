import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fatal } from './errors.js';

export type AuthMethod = 'device-code' | 'passwordless';

export interface Profile {
  host?: string;
  auth_method?: AuthMethod;
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
}

type ConfigFile = Record<string, Profile>;

const CONFIG_DIR = join(homedir(), '.vsql');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

// IDP configuration — fail loud; no silent defaults that send the wrong client.
const IDP_BASE = process.env.VSQL_IDP_URL as string | undefined;
const CLIENT_ID = process.env.VSQL_CLIENT_ID as string | undefined;
// IDP device-context enum — server-validated CLOSED set: 'vibe_agents_no_acp'
// = a CLI running OUTSIDE ACP (this CLI's case); 'vibe_agents_acp' = within
// ACP. A REQUIRED contract value stamped into the token, NOT a per-device id
// or secret — a free-form/UUID value is rejected (400 VALIDATION_ERROR).
const DEVICE_ID = 'vibe_agents_no_acp';

/** Returns the configured IDP base URL, or fails loud if VSQL_IDP_URL is unset. */
export function idpBase(): string {
  if (!IDP_BASE) {
    fatal('NO_IDP_URL', 'Missing VSQL_IDP_URL environment variable.', 'Set VSQL_IDP_URL to your IDP base URL (e.g. https://idp.payez.net).');
  }
  return IDP_BASE;
}

/** Returns the configured OAuth client id, or fails loud if VSQL_CLIENT_ID is unset. */
export function clientId(): string {
  if (!CLIENT_ID) {
    fatal('NO_CLIENT_ID', 'Missing VSQL_CLIENT_ID environment variable.', 'Set VSQL_CLIENT_ID to your IDP OAuth client id.');
  }
  return CLIENT_ID;
}

export function deviceId(): string {
  return DEVICE_ID;
}

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
  // Best-effort tighten permissions (Unix only; Windows ignores this).
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* ignore */ }
}

export function getProfile(name: string = 'default'): Profile {
  return readConfig()[name] ?? {};
}

/** Persist a single profile, merging over whatever is already stored under that name. */
export function saveProfile(name: string, profile: Profile): void {
  const config = readConfig();
  config[name] = profile;
  writeConfig(config);
}

export function setProfileHost(value: string, profile: string = 'default'): void {
  const config = readConfig();
  config[profile] = config[profile] ?? {};
  config[profile].host = value;
  writeConfig(config);
}

/** Clear the auth tokens from a single profile (logout), keeping host. */
export function clearProfileAuth(profile: string = 'default'): void {
  const config = readConfig();
  const existing = config[profile];
  if (existing) {
    const { access_token, refresh_token, expires_at, auth_method, ...rest } = existing;
    config[profile] = rest;
    writeConfig(config);
  }
}

export function clearConfig(): void {
  writeConfig({});
}

export function showConfig(): void {
  const config = readConfig();
  // Key-signing lives in the environment, never in the file; say which is active, never the secret.
  const keyId = process.env.VIBE_CLIENT_ID?.trim();
  if (keyId || process.env.VIBE_HMAC_KEY) {
    console.log('[environment]');
    console.log(`  auth:         key-signing (KeelBase client id ${keyId ?? '(VIBE_CLIENT_ID unset)'}, secret ${process.env.VIBE_HMAC_KEY ? 'set' : 'NOT set'})`);
  }
  if (Object.keys(config).length === 0) {
    // With key-signing configured, a missing sign-in profile is not a problem to fix (rigpert 63609).
    if (keyId && process.env.VIBE_HMAC_KEY) console.log('  sign-in:      no sign-in profile (not needed for key-signing; `vsql login` only for schema changes)');
    else console.log('No config found. Run `vsql login` to authenticate.');
    return;
  }
  for (const [name, profile] of Object.entries(config)) {
    console.log(`[${name}]`);
    if (profile.host) console.log(`  host:         ${profile.host}`);
    if (profile.auth_method) console.log(`  auth_method:  ${profile.auth_method}`);
    if (profile.access_token) console.log(`  access_token: ${mask(profile.access_token)}`);
    if (profile.refresh_token) console.log(`  refresh_token: ${mask(profile.refresh_token)}`);
    if (profile.expires_at) console.log(`  expires_at:   ${profile.expires_at}`);
  }
}

function mask(value: string): string {
  return value.length > 12 ? value.slice(0, 6) + '***' + value.slice(-4) : '***';
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT / token helpers
// ─────────────────────────────────────────────────────────────────────────────

export function decodeJwtExp(token: string): Date | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    if (typeof payload.exp === 'number') {
      return new Date(payload.exp * 1000);
    }
    return null;
  } catch {
    return null;
  }
}

export function computeExpiresAt(accessToken: string): string {
  const jwtExp = decodeJwtExp(accessToken);
  return (jwtExp ?? new Date(Date.now() + 15 * 60 * 1000)).toISOString();
}

export function isTokenExpired(profile: Profile): boolean {
  if (!profile.expires_at) return true;
  const expiresAt = new Date(profile.expires_at);
  // Refresh 5 minutes before expiry.
  return Date.now() >= expiresAt.getTime() - 5 * 60 * 1000;
}

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; refresh_token?: string } | null> {
  try {
    // The client does NOT assert amr/acr — the IDP is the authority on the
    // authentication-method-reference and derives it from the original grant
    // tied to the refresh token. (Never forge amr.)
    const body = JSON.stringify({ refresh_token: refreshToken });
    const response = await fetch(`${idpBase()}/api/ExternalAuth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': clientId(),
        'X-Device-Id': DEVICE_ID,
        'User-Agent': 'vsql-cli',
      },
      body,
    });
    if (!response.ok) return null;
    const data = await response.json() as { data?: { access_token: string; refresh_token?: string }; access_token?: string; refresh_token?: string };
    return data.data ?? (data.access_token ? { access_token: data.access_token, refresh_token: data.refresh_token } : null);
  } catch {
    return null;
  }
}

/**
 * Return a valid access token for the profile, refreshing via refresh_token when
 * the stored token is expired. Returns null when no usable token is available.
 */
export async function getValidAccessToken(profileName: string = 'default'): Promise<string | null> {
  const profile = getProfile(profileName);

  // Still-valid access token: use it directly.
  if (profile.access_token && !isTokenExpired(profile)) {
    return profile.access_token;
  }

  // Expired (or near-expiry): refresh.
  if (profile.refresh_token) {
    const refreshed = await refreshAccessToken(profile.refresh_token);
    if (refreshed) {
      saveProfile(profileName, {
        ...profile,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? profile.refresh_token,
        expires_at: computeExpiresAt(refreshed.access_token),
      });
      return refreshed.access_token;
    }
  }

  return null;
}

/**
 * Resolve a host + a VALID access token for the given flags.
 * Host resolution: --host > VSQL_HOST env > profile.host (no silent localhost default).
 */
export async function resolveAuth(flags: { host?: string; profile?: string }): Promise<{ host: string; token: string }> {
  const profileName = flags.profile ?? 'default';
  const profile = getProfile(profileName);

  const host = flags.host ?? process.env.VSQL_HOST ?? profile.host;
  if (!host) {
    fatal('NO_HOST', 'No host configured.', 'Pass --host, set VSQL_HOST, or run `vsql login`. Refusing to silently hit localhost.');
  }

  const token = await getValidAccessToken(profileName);
  if (!token) {
    fatal('NO_SESSION', 'Not authenticated (no valid access token).', 'Run `vsql login` to authenticate.');
  }

  return { host, token };
}

// ─────────────────────────────────────────────────────────────────────────────
// Connections (v1.3.0): one type the client takes, whatever the auth.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a command reaches VibeSQL.
 *  - bearer: a VibeSQL Server host directly, with the access token from `vsql login` (unchanged from v1.2.0).
 *  - anon:   a VibeSQL Server host with no credentials (health only).
 *  - key:    the hosted VibeSQL through the identity service's proxy, POST {IdP}/api/vibe/proxy, signed with the
 *            KeelBase client id + KeelBase secret (PAY-1738). Never reaches a VibeSQL host directly.
 */
export type Conn =
  | { kind: 'bearer'; host: string; token: string }
  | { kind: 'anon'; host: string }
  | { kind: 'key'; idp: string; clientId: string; secret: string };

/**
 * Key-signing credentials, from the ENVIRONMENT ONLY: VIBE_CLIENT_ID + VIBE_HMAC_KEY (the names the SDK uses, so one
 * .env serves both). Never from argv (shell history, process lists) and never written to ~/.vsql/config.json.
 * Returns null when neither is set (use login mode). Half a pair fails loud rather than silently using login mode.
 */
export function keyCredentials(): { idp: string; clientId: string; secret: string } | null {
  const id = process.env.VIBE_CLIENT_ID?.trim();
  const secret = process.env.VIBE_HMAC_KEY?.trim();
  if (!id && !secret) return null;
  if (!id || !secret) {
    fatal('INCOMPLETE_KEY', `${id ? 'VIBE_HMAC_KEY' : 'VIBE_CLIENT_ID'} is not set.`,
      'Key-signing needs BOTH VIBE_CLIENT_ID (your KeelBase client id, vibe_...) and VIBE_HMAC_KEY (your KeelBase secret).');
  }
  if (!/^vibe_[0-9a-f]{16}$/i.test(id)) {
    fatal('INVALID_CLIENT_ID', 'VIBE_CLIENT_ID is not a KeelBase client id.', 'It looks like vibe_ followed by 16 hex characters; copy it from the KeelBase page.');
  }
  const idp = (process.env.VSQL_IDP_URL ?? process.env.IDP_URL)?.trim();
  if (!idp) {
    fatal('NO_IDP_URL', 'Missing VSQL_IDP_URL (or IDP_URL).', 'Key-signing calls go through the identity service, e.g. VSQL_IDP_URL=https://idp.payez.net');
  }
  return { idp: idp.replace(/\/$/, ''), clientId: id, secret };
}

/** The connection for an authenticated command: key-signing when VIBE_CLIENT_ID + VIBE_HMAC_KEY are set, else login. */
export async function resolveConn(flags: { host?: string; profile?: string }): Promise<Conn> {
  const key = keyCredentials();
  if (key) {
    if (flags.host) fatal('HOST_WITH_KEY', '--host does not apply with a KeelBase secret.', 'Key-signed calls go through the identity service (VSQL_IDP_URL). Unset VIBE_CLIENT_ID / VIBE_HMAC_KEY to use --host with `vsql login`.');
    return { kind: 'key', ...key };
  }
  const { host, token } = await resolveAuth(flags);
  return { kind: 'bearer', host, token };
}

/** The connection for `health`: key-signing when configured (it checks the hosted service), else the host, keyless. */
export function resolveHealthConn(flags: { host?: string; profile?: string }): Conn {
  const key = keyCredentials();
  if (key && !flags.host) return { kind: 'key', ...key };
  return { kind: 'anon', host: resolveHost(flags) };
}

/** Resolve just the host (for keyless calls like health). Fails loud if unset. */
export function resolveHost(flags: { host?: string; profile?: string }): string {
  const profile = getProfile(flags.profile ?? 'default');
  const host = flags.host ?? process.env.VSQL_HOST ?? profile.host;
  if (!host) {
    fatal('NO_HOST', 'No host configured.', 'Pass --host, set VSQL_HOST, or run `vsql login`. Refusing to silently hit localhost.');
  }
  return host;
}
