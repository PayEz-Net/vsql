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

/**
 * PAY-1814 (Jon via rigpert 64624/64638): the documented variable is KEELBASE_CLIENT_ID - the
 * developer's own Tenant (the name the KeelBase page shows as "Tenant"). VSQL_CLIENT_ID is kept as a
 * DEPRECATED fallback so existing .env files keep working, with one warning.
 *
 * The resolution, in ONE place so every caller (clientId(), help, docs) agrees:
 *   - KEELBASE_CLIENT_ID set                     -> use it, no warning.
 *   - only VSQL_CLIENT_ID set                    -> use it, ONE deprecation warning.
 *   - both set and DIFFERENT                     -> refuse (a typo, or a half-migrated .env, must not
 *                                                   silently pick one).
 *   - neither                                    -> fail loud, as before.
 */
export interface ClientIdResolution {
  /** The resolved client id, when there is exactly one to use. */
  clientId?: string;
  /** True when the value came from the deprecated VSQL_CLIENT_ID. */
  deprecated: boolean;
  /** True when both names are set to DIFFERENT values - the caller must refuse. */
  conflict: boolean;
  /** True when neither name is set. */
  missing: boolean;
  /**
   * True when the resolved value is a KeelBase CLIENT id (`vibe_...`), not a Tenant (NightHawk 64681
   * SHOULD). The new name invites pasting the `vibe_` signing credential where the Tenant belongs; the
   * Tenant is a name (slug or email), never `vibe_`. Refused, not sent.
   */
  keelbaseClientIdMistake: boolean;
}

const nonEmpty = (v: string | undefined): string => (v ?? '').trim();

/** The KeelBase client id shape (the `vibe_` signing credential) - NEVER a Tenant. */
export const KEELBASE_CLIENT_ID_SHAPE = /^vibe_[A-Za-z0-9]{4,64}$/;

/** Pure: resolve the client id from the two env names. Never reads process.env itself, so it is testable. */
export function resolveClientId(env: Record<string, string | undefined>): ClientIdResolution {
  const keelbase = nonEmpty(env.KEELBASE_CLIENT_ID);
  const legacy = nonEmpty(env.VSQL_CLIENT_ID);

  if (keelbase && legacy && keelbase !== legacy) {
    return { deprecated: false, conflict: true, missing: false, keelbaseClientIdMistake: false };
  }
  const value = keelbase || legacy;
  if (!value) return { deprecated: false, conflict: false, missing: true, keelbaseClientIdMistake: false };
  if (KEELBASE_CLIENT_ID_SHAPE.test(value)) {
    return { deprecated: false, conflict: false, missing: false, keelbaseClientIdMistake: true };
  }
  return { clientId: value, deprecated: !keelbase, conflict: false, missing: false, keelbaseClientIdMistake: false };
}

// Emit the deprecation warning at most ONCE per process, however many times clientId() is called.
let warnedLegacyClientId = false;

// IDP device-context enum — server-validated CLOSED set: 'vibe_agents_no_acp'
// = a CLI running OUTSIDE ACP (this CLI's case); 'vibe_agents_acp' = within
// ACP. A REQUIRED contract value stamped into the token, NOT a per-device id
// or secret — a free-form/UUID value is rejected (400 VALIDATION_ERROR).
const DEVICE_ID = 'vibe_agents_no_acp';

/**
 * PAY-1975 v1.3.2 (Vasanth intake, flaw 3): names FOR EACH env var whether the process picked it
 * up from the real shell environment, from a loaded `.env` file, or (for the key pair) from
 * neither. Populated by `loadDotEnv()`; read by `health`/`config show` to name a value's SOURCE —
 * never the value itself. `envSource()` below is the one place that answers "where did this
 * come from", so `.env`-loading and reporting can't drift apart.
 *
 * Tracked by VALUE, not just key presence: `envSource(name)` reports '.env' only when
 * process.env[name] STILL EQUALS the value loadDotEnv() set. A bare key->loaded Set would go
 * stale the moment something else (a later real env var, a test) sets the SAME NAME to a
 * DIFFERENT value without going through loadDotEnv again — reporting '.env' would then be wrong.
 */
const DOTENV_VALUES = new Map<string, string>();

/** Which of ('env' | '.env' | undefined) supplied `name` in process.env right now. Never returns the value. */
export function envSource(name: string): 'env' | '.env' | undefined {
  const current = process.env[name];
  if (current === undefined) return undefined;
  return DOTENV_VALUES.get(name) === current ? '.env' : 'env';
}

/**
 * PAY-1975 v1.3.2 (Vasanth intake, flaw 3): load a `.env` file from the CURRENT WORKING DIRECTORY
 * (not the CLI's install location) into process.env, WITHOUT EVER overriding a real environment
 * variable that is already set — a real env var always wins, silently, by design (a developer who
 * exports VIBE_HMAC_KEY in their shell for one call should not have a stale .env value win instead).
 * Missing/unreadable .env is not an error: most invocations have none. Malformed lines are skipped,
 * not fatal — a typo in an unrelated line must not block every command.
 */
export function loadDotEnv(cwd: string = process.cwd()): void {
  const path = join(cwd, '.env');
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return; // no .env — the common case, not an error
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // no '=', or a line starting with '=' — not KEY=VALUE, skip rather than fatal
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // not a shell-legal identifier — skip
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, same convention as `.env` files elsewhere in this repo.
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] !== undefined) continue; // a real env var already set it — never override
    process.env[key] = value;
    DOTENV_VALUES.set(key, value);
  }
}

/** Returns the configured IDP base URL, or fails loud if VSQL_IDP_URL is unset. */
export function idpBase(): string {
  const idpBase = process.env.VSQL_IDP_URL;
  if (!idpBase) {
    fatal('NO_IDP_URL', 'Missing VSQL_IDP_URL environment variable.', 'Set VSQL_IDP_URL to your IDP base URL (e.g. https://idp.payez.net).');
  }
  return idpBase;
}

/**
 * Returns the configured OAuth client id (PAY-1814: KEELBASE_CLIENT_ID first, VSQL_CLIENT_ID as the
 * deprecated fallback), or fails loud if neither is set. Refuses when both are set to DIFFERENT values.
 */
export function clientId(): string {
  const r = resolveClientId(process.env);
  if (r.conflict) {
    fatal(
      'CLIENT_ID_CONFLICT',
      'Both KEELBASE_CLIENT_ID and VSQL_CLIENT_ID are set, to DIFFERENT values.',
      'Remove the old VSQL_CLIENT_ID (it is deprecated) so only KEELBASE_CLIENT_ID names your Tenant.',
    );
  }
  if (r.missing) {
    fatal(
      'NO_CLIENT_ID',
      'Missing KEELBASE_CLIENT_ID environment variable.',
      'Set KEELBASE_CLIENT_ID to your Tenant (the name your KeelBase page shows as "Tenant").',
    );
  }
  if (r.keelbaseClientIdMistake) {
    fatal(
      'CLIENT_ID_IS_KEELBASE_CLIENT_ID',
      'KEELBASE_CLIENT_ID looks like a KeelBase client id (vibe_...), which is a signing credential, not a Tenant.',
      'Use your Tenant - the name your KeelBase page shows as "Tenant" (a slug or your email), not the vibe_ id.',
    );
  }
  if (r.deprecated && !warnedLegacyClientId) {
    warnedLegacyClientId = true;
    process.stderr.write(
      'Warning: VSQL_CLIENT_ID is deprecated; rename it to KEELBASE_CLIENT_ID (its value is your Tenant).\n',
    );
  }
  return r.clientId as string;
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

/**
 * PAY-1975 v1.3.2 (Vasanth intake, flaws 3+4): names WHERE `health` got its mode, host and
 * credential from - never the credential value itself. This is what makes a stale saved profile
 * or a shadowing env var visible instead of silently answering "healthy" for the wrong server.
 */
export interface HealthSource {
  mode: 'key-signing' | 'sign-in' | 'anonymous';
  /**
   * Where VIBE_CLIENT_ID and VIBE_HMAC_KEY each came from, in key-signing mode - SEPARATELY.
   * PAY-1978 MUST (rigpert 67321): the id and the key can come from DIFFERENT sources at once -
   * that mixed-source case is exactly what bit Vasanth (a Windows user-level VIBE_HMAC_KEY
   * beating the shell's, while VIBE_CLIENT_ID still came from the shell). Reporting only one
   * combined source hides that; the two must be named independently.
   */
  clientIdSource?: 'env' | '.env';
  keySource?: 'env' | '.env';
  /** Where the host came from: the flag, an env var (real or .env), or a named saved profile. */
  hostSource: '--host' | 'VSQL_HOST (env)' | 'VSQL_HOST (.env)' | `profile "${string}"` | 'none';
}

export function describeHealthSource(flags: { host?: string; profile?: string }): HealthSource {
  const key = process.env.VIBE_CLIENT_ID?.trim() && process.env.VIBE_HMAC_KEY?.trim();
  if (key && !flags.host) {
    return { mode: 'key-signing', clientIdSource: envSource('VIBE_CLIENT_ID'), keySource: envSource('VIBE_HMAC_KEY'), hostSource: 'none' };
  }
  const profileName = flags.profile ?? 'default';
  const profile = getProfile(profileName);
  let hostSource: HealthSource['hostSource'];
  if (flags.host) hostSource = '--host';
  else if (process.env.VSQL_HOST !== undefined) hostSource = envSource('VSQL_HOST') === '.env' ? 'VSQL_HOST (.env)' : 'VSQL_HOST (env)';
  else if (profile.host) hostSource = `profile "${profileName}"`;
  else hostSource = 'none';
  return { mode: profile.access_token ? 'sign-in' : 'anonymous', hostSource };
}
