import { readFileSync } from 'fs';
import { createInterface } from 'readline';
import * as client from './client.js';
import {
  resolveConn,
  resolveHealthConn,
  describeHealthSource,
  getProfile,
  setProfileHost,
  saveProfile,
  clearProfileAuth,
  showConfig,
  clearConfig,
  computeExpiresAt,
  idpBase,
  clientId,
  deviceId,
  loadDotEnv,
  type Profile,
} from './config.js';
import { formatRows, detectFormat, type Format } from './format.js';
import { fatal } from './errors.js';

const VERSION = '1.3.2';

interface Flags {
  host?: string;
  profile?: string;
  format?: string;
  file?: string;
  data?: string;
  schema?: string;
  version?: number;
  'dry-run'?: boolean;
  list?: boolean;
  yes?: boolean;
  batch?: boolean;
  'client-id'?: number;
  email?: string;
  passwordless?: string;
  page?: number;
  'page-size'?: number;
}

const BOOLEAN_FLAGS = ['dry-run', 'list', 'yes', 'batch'];
const VALUE_FLAGS = ['host', 'profile', 'format', 'file', 'data', 'schema', 'version', 'client-id', 'email', 'passwordless', 'page', 'page-size'];

function parseArgs(argv: string[]): { command: string; positionals: string[]; flags: Flags } {
  const command = argv[0] ?? 'help';
  const flags: Flags = {};
  const positionals: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'help') return { command: 'help', positionals: [], flags: {} };
      // An unknown flag used to be taken silently, with the next word as its value (rigpert 63618: `rows --limit 3`).
      if (!BOOLEAN_FLAGS.includes(key) && !VALUE_FLAGS.includes(key)) {
        fatal('UNKNOWN_FLAG', `Unknown option "--${key}".`, key === 'limit' ? 'Use --page-size <n> (and --page <n>) with `vsql rows`.' : 'Run `vsql help` for the list of options.');
      }
      if (BOOLEAN_FLAGS.includes(key)) {
        (flags as Record<string, unknown>)[key] = true;
      } else {
        const val = argv[++i];
        if (key === 'version' || key === 'client-id' || key === 'page' || key === 'page-size') {
          (flags as Record<string, unknown>)[key] = parseInt(val, 10);
        } else {
          (flags as Record<string, unknown>)[key] = val;
        }
      }
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags };
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

/**
 * PAY-1975: parse a --data payload for a single-row write. Reject invalid JSON locally, with the
 * offending text and the parser's own message, rather than letting a malformed body reach the
 * server half-parsed (or, worse, sent as a literal string).
 */
function parseDataFlag(raw: string, usage: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fatal('INVALID_JSON', `--data is not valid JSON: ${(err as Error).message}`, usage);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fatal('INVALID_JSON', '--data must be a JSON object, e.g. \'{"key":"value"}\'.', usage);
  }
  return parsed as Record<string, unknown>;
}

/**
 * PAY-1975 delete safety: a TTY prompts for confirmation (`--yes` skips it); a non-TTY without
 * `--yes` refuses outright, so a hackathon script piping into `vsql delete` can't delete by
 * accident just because nothing was there to answer a prompt it never saw. Returns false (and
 * prints why) on anything short of an explicit "yes" - the caller `break`s rather than deleting,
 * the same cancel idiom `rollback` and `schema update` already use.
 */
async function confirmDelete(collection: string, table: string, id: string, flags: Flags): Promise<boolean> {
  if (flags.yes) return true;
  if (!process.stdin.isTTY) {
    fatal('CONFIRMATION_REQUIRED', `Refusing to delete ${collection}.${table} id=${id} without confirmation.`, 'Pass --yes to delete without a prompt (non-interactive).');
  }
  const answer = await prompt(`Delete ${collection}.${table} id=${id}? Type "yes" to confirm: `);
  if (answer !== 'yes') { console.log('Delete cancelled.'); return false; }
  return true;
}

function getTableNames(schema: unknown): string[] {
  if (schema && typeof schema === 'object' && 'tables' in schema) {
    return Object.keys((schema as { tables: Record<string, unknown> }).tables);
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth flows (IDP device-code + passwordless)
// ─────────────────────────────────────────────────────────────────────────────

async function startDeviceAuth(): Promise<{ device_code: string; user_code: string; verification_url: string; expires_in: number; interval: number }> {
  const body = JSON.stringify({ client: clientId(), device_id: deviceId() });
  const response = await fetch(`${idpBase()}/api/ExternalAuth/agent-device/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': clientId(),
      'User-Agent': 'vsql-cli',
    },
    body,
  }).catch(() => null);

  if (!response) fatal('CONNECTION_FAILED', `Could not connect to ${idpBase()}`, 'Check your network and VSQL_IDP_URL.');
  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: { message?: string } };
    fatal('DEVICE_AUTH_FAILED', `Device auth start failed (HTTP ${response.status}): ${err.error?.message ?? response.statusText}`);
  }

  type DeviceAuth = { device_code: string; user_code: string; verification_url: string; expires_in: number; interval: number };
  const result = await response.json() as { data?: DeviceAuth } & Partial<DeviceAuth>;
  return (result.data ?? result) as DeviceAuth;
}

async function pollDeviceAuth(deviceCode: string): Promise<{ success: boolean; access_token?: string; refresh_token?: string; expires_in?: number; error?: string }> {
  const body = JSON.stringify({ device_code: deviceCode });
  const response = await fetch(`${idpBase()}/api/ExternalAuth/agent-device/poll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': clientId(),
      'User-Agent': 'vsql-cli',
    },
    body,
  });

  const result = await response.json() as {
    success?: boolean;
    data?: { access_token?: string; refresh_token?: string; expires_in?: number; status?: string; error?: { code?: string } };
    error?: { code?: string };
  };
  const innerData = result.data ?? {};

  if (response.ok && result.success && innerData.access_token) {
    return { success: true, access_token: innerData.access_token, refresh_token: innerData.refresh_token, expires_in: innerData.expires_in };
  }

  const status = innerData.status ?? innerData.error?.code ?? result.error?.code ?? 'unknown';
  return { success: false, error: status.toLowerCase() };
}

async function startPasswordless(email: string): Promise<void> {
  // The IDP resolves the client from the X-Client-Id header (sent below); a
  // client_id in the body is ignored, so we don't assert one.
  const body = JSON.stringify({ email });
  const response = await fetch(`${idpBase()}/api/ExternalAuth/passwordless/email/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': clientId(),
      'User-Agent': 'vsql-cli',
    },
    body,
  }).catch(() => null);

  if (!response) fatal('CONNECTION_FAILED', `Could not connect to ${idpBase()}`, 'Check your network and VSQL_IDP_URL.');
  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: { message?: string } };
    fatal('PASSWORDLESS_FAILED', `Passwordless start failed (HTTP ${response.status}): ${err.error?.message ?? response.statusText}`);
  }

  const result = await response.json() as { success?: boolean; message?: string; data?: { success?: boolean; message?: string } };
  const data = result.data ?? result;
  if (!data.success && !result.success) {
    fatal('PASSWORDLESS_FAILED', data.message ?? result.message ?? 'Failed to send verification code.');
  }
}

async function completePasswordless(email: string, code: string): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const body = JSON.stringify({ email, code });
  const response = await fetch(`${idpBase()}/api/ExternalAuth/passwordless/email/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': clientId(),
      'X-Device-Id': deviceId(),
      'User-Agent': 'vsql-cli',
    },
    body,
  }).catch(() => null);

  if (!response) fatal('CONNECTION_FAILED', `Could not connect to ${idpBase()}`, 'Check your network and VSQL_IDP_URL.');
  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: { message?: string } };
    fatal('PASSWORDLESS_FAILED', `Passwordless login failed (HTTP ${response.status}): ${err.error?.message ?? response.statusText}`);
  }

  const result = await response.json() as {
    success?: boolean;
    message?: string;
    access_token?: string;
    accessToken?: string;
    refresh_token?: string;
    refreshToken?: string;
    expires_in?: number;
    expiresIn?: number;
    data?: { success?: boolean; message?: string; access_token?: string; accessToken?: string; refresh_token?: string; refreshToken?: string; expires_in?: number; expiresIn?: number };
  };
  const data = result.data ?? result;

  if (!data.success && !result.success) {
    fatal('PASSWORDLESS_FAILED', data.message ?? result.message ?? 'Invalid code.');
  }
  if (!data.access_token && !data.accessToken) {
    fatal('PASSWORDLESS_FAILED', 'No access token returned. Please try again.');
  }

  return {
    access_token: (data.access_token ?? data.accessToken)!,
    refresh_token: data.refresh_token ?? data.refreshToken,
    expires_in: data.expires_in ?? data.expiresIn ?? 3600,
  };
}

async function loginDeviceCode(profileName: string): Promise<void> {
  console.error('VibeSQL CLI Login (Device Code Flow)');
  console.error('=====================================');
  console.error(`IDP: ${idpBase()}`);
  console.error('');

  console.error('Starting device authorization...');
  const deviceAuth = await startDeviceAuth();
  const { user_code, verification_url, device_code, expires_in, interval } = deviceAuth;
  const displayUrl = verification_url || `${idpBase()}/auth/device`;

  console.error('');
  console.error('='.repeat(50));
  console.error('');
  console.error(`  Go to:  ${displayUrl}`);
  console.error('');
  console.error(`  Enter code:  ${user_code}`);
  console.error('');
  console.error('='.repeat(50));
  console.error('');
  console.error(`Waiting for approval (expires in ${expires_in || 900}s)...`);

  const startTime = Date.now();
  const timeout = (expires_in || 900) * 1000;
  let pollInterval = (interval || 5) * 1000;

  while (Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    const result = await pollDeviceAuth(device_code);

    if (result.success && result.access_token) {
      const expiresAt = computeExpiresAt(result.access_token);
      const existing = getProfile(profileName);
      const profile: Profile = {
        ...existing,
        auth_method: 'device-code',
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        expires_at: expiresAt,
      };
      saveProfile(profileName, profile);
      console.error('');
      console.error('Approved. Tokens saved.');
      console.error(`  Expires: ${expiresAt}`);
      console.error('');
      console.error('You can now run vsql queries.');
      return;
    }

    switch (result.error) {
      case 'authorization_pending':
        process.stderr.write('.');
        continue;
      case 'slow_down':
        console.error(' (slowing down)');
        pollInterval = Math.min(pollInterval * 2, 60000);
        continue;
      case 'access_denied':
        fatal('ACCESS_DENIED', 'Access denied by user.');
        break;
      case 'expired_token':
        fatal('CODE_EXPIRED', 'Code expired.', 'Run `vsql login` again.');
        break;
      case 'already_used':
        fatal('CODE_USED', 'Code already used.', 'Run `vsql login` again.');
        break;
      default:
        fatal('DEVICE_AUTH_FAILED', `Unknown error: ${result.error}`);
    }
  }

  fatal('LOGIN_TIMEOUT', 'Timeout waiting for approval.', 'Run `vsql login` again.');
}

async function loginPasswordless(profileName: string, emailArg?: string): Promise<void> {
  console.error('VibeSQL CLI Login (Passwordless)');
  console.error('=================================');
  console.error(`IDP: ${idpBase()}`);
  console.error('');

  const email = emailArg ?? await prompt('Email: ');
  if (!email || !email.includes('@')) fatal('INVALID_EMAIL', 'Invalid email address.');

  console.error('Sending verification code...');
  await startPasswordless(email);
  console.error('Code sent. Check your email.');
  console.error('');

  const code = await prompt('Enter the 6-digit code: ');
  if (!code || !/^\d{6}$/.test(code)) fatal('INVALID_CODE', 'Invalid code format. Expected 6 digits.');

  console.error('Verifying...');
  const tokens = await completePasswordless(email, code);
  const expiresAt = computeExpiresAt(tokens.access_token);
  const existing = getProfile(profileName);
  const profile: Profile = {
    ...existing,
    auth_method: 'passwordless',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
  };
  saveProfile(profileName, profile);
  console.error('');
  console.error('Logged in. Tokens saved.');
  console.error(`  Expires: ${expiresAt}`);
  console.error('');
  console.error('You can now run vsql queries.');
}

async function run(): Promise<void> {
  // PAY-1975 v1.3.2 (Vasanth intake, flaw 3): before anything else reads an env var, load .env
  // from the CURRENT DIRECTORY. Must run before parseArgs/resolveConn/idpBase/clientId — all of
  // which read process.env directly — so it is the very first statement in run().
  loadDotEnv();

  const args = process.argv.slice(2);
  const { command, positionals, flags } = parseArgs(args);
  const positional = positionals[0] ?? '';

  switch (command) {
    case 'query': {
      const conn = await resolveConn(flags);
      client.refuseQueryWithKey(conn);
      let sql = positional;
      if (flags.file) sql = readFileSync(flags.file, 'utf-8').trim();
      if (!sql) fatal('NO_QUERY', 'No SQL provided.', 'Pass SQL as argument or use --file.');
      const result = await client.query(conn, sql);
      const rows = result.data ?? result.rows ?? [];
      const format = detectFormat(flags.format);
      const meta = result.meta ?? { rowCount: result.rowCount, executionTimeMs: result.executionTime };
      console.log(formatRows(rows, format, meta));
      break;
    }

    case 'tables': {
      // PAY-1978 (Jon-ruled): information_schema.tables 403s for tenant keys on prod - the raw
      // query path is platform-admin-only. Tables now come from the Vibe-native GET /v1/schemas
      // (client.listSchemas), the same source `schemas` uses. --schema no longer means anything
      // here (there is no Postgres schema namespace to pick) - refuse it locally rather than
      // silently ignore it.
      if (flags.schema) fatal('SCHEMA_FLAG_REMOVED', '--schema is not used by `tables` any more.', 'Run `vsql schemas` to see every collection and its schema.');
      const conn = await resolveConn(flags);
      const schemas = await client.listSchemas(conn);
      const active = schemas.filter(s => s.is_active);
      if (positional) {
        const match = active.find(s => s.collection === positional);
        if (!match) fatal('COLLECTION_NOT_FOUND', `No active schema for collection "${positional}".`, 'Run `vsql schemas` to see what exists.');
        const tables = getTableNames(match.json_schema);
        if (tables.length === 0) { console.log(`${positional}: no tables.`); break; }
        console.log(formatRows(tables.map(t => ({ table: t })), detectFormat(flags.format)));
      } else {
        if (active.length === 0) { console.log('No collections.'); break; }
        for (const s of active) {
          const tables = getTableNames(s.json_schema);
          console.log(`${s.collection}: ${tables.length === 0 ? '(no tables)' : tables.join(', ')}`);
        }
      }
      break;
    }

    case 'schemas': {
      // PAY-1978 (Jon-ruled): every collection and its active schema, including ones with no
      // documents yet - `collections` only lists collections that have some.
      const conn = await resolveConn(flags);
      const schemas = (await client.listSchemas(conn)).filter(s => s.is_active);
      if (schemas.length === 0) { console.log('No collections.'); break; }
      console.log(formatRows(
        schemas.map(s => ({ collection: s.collection, version: s.version, tables: getTableNames(s.json_schema).length, created_at: s.created_at })),
        detectFormat(flags.format),
      ));
      break;
    }

    case 'describe': {
      if (!positional) fatal('NO_TABLE', 'No table name provided.', 'Usage: vsql describe <table>');
      const conn = await resolveConn(flags);
      const sql = `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = '${positional}' ORDER BY ordinal_position`;
      const result = await client.query(conn, sql);
      const rows = result.data ?? result.rows ?? [];
      if (rows.length === 0) fatal('TABLE_NOT_FOUND', `Table "${positional}" not found or has no columns.`);
      const format = detectFormat(flags.format);
      console.log(formatRows(rows, format));
      break;
    }

    case 'collections': {
      const conn = await resolveConn(flags);
      const list = await client.listCollections(conn);
      if (list.length === 0) { console.log('No collections.'); break; }
      console.log(formatRows(list, detectFormat(flags.format)));
      break;
    }

    case 'rows': {
      const collection = positional;
      const table = positionals[1];
      if (!collection || !table) fatal('MISSING_ARGS', 'Collection and table required.', 'Usage: vsql rows <collection> <table> [--page N] [--page-size N]');
      const page = flags.page ?? 1;
      const pageSize = flags['page-size'] ?? 20;
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1) fatal('INVALID_ARGS', '--page and --page-size must be whole numbers, 1 or more.');
      const conn = await resolveConn(flags);
      const result = await client.listRows(conn, collection, table, page, pageSize);
      const format = detectFormat(flags.format);
      if (result.rows.length === 0) console.log(`No rows in ${collection}.${table}${page > 1 ? ` on page ${page}` : ''}.`);
      else console.log(formatRows(result.rows, format));
      if (result.total != null && format === 'table') console.error(`Page ${page}, ${result.rows.length} of ${result.total} rows.`);
      break;
    }

    case 'rollback': {
      if (!positional) fatal('NO_COLLECTION', 'No collection name provided.', 'Usage: vsql rollback <collection>');
      const conn = await resolveConn(flags);
      const collection = positional;
      if (!flags.list && !flags['dry-run']) client.refuseDdlWithKey(conn, 'rollback');

      if (flags.list) {
        const versions = await client.getVersions(conn, collection);
        if (versions.length === 0) { console.log('No versions found.'); break; }
        for (const v of versions) {
          const tables = getTableNames(v.json_schema);
          const active = v.is_active ? ' (active)' : '';
          console.log(`  v${v.version}: ${tables.length} tables, ${v.created_at}${active}`);
        }
        break;
      }

      if (flags['dry-run']) {
        const versions = await client.getVersions(conn, collection);
        const active = versions.find(v => v.is_active);
        const targetVer = flags.version ?? (versions.find(v => !v.is_active)?.version);
        const target = versions.find(v => v.version === targetVer);
        if (!target) fatal('VERSION_NOT_FOUND', 'No target version found for dry-run.');
        const activeTables = active ? getTableNames(active.json_schema) : [];
        const targetTables = getTableNames(target.json_schema);
        const removed = activeTables.filter(t => !targetTables.includes(t));
        const added = targetTables.filter(t => !activeTables.includes(t));
        console.log(`Dry-run: rolling back "${collection}" to version ${target.version}`);
        console.log(`  Current: ${activeTables.length} tables (version ${active?.version ?? '?'}, active)`);
        console.log(`  Target:  ${targetTables.length} tables (version ${target.version})`);
        console.log(`  Tables removed: ${removed.length > 0 ? removed.join(', ') : '(none)'}`);
        console.log(`  Tables added: ${added.length > 0 ? added.join(', ') : '(none)'}`);
        break;
      }

      if (!flags.yes) {
        const versions = await client.getVersions(conn, collection);
        const active = versions.find(v => v.is_active);
        const targetVer = flags.version ?? (versions.find(v => !v.is_active)?.version);
        const target = versions.find(v => v.version === targetVer);
        if (!target) fatal('VERSION_NOT_FOUND', 'No target version found.', 'Use `vsql rollback <collection> --list` to see available versions');
        const activeTables = active ? getTableNames(active.json_schema) : [];
        const targetTables = getTableNames(target.json_schema);
        const removed = activeTables.filter(t => !targetTables.includes(t));
        const added = targetTables.filter(t => !activeTables.includes(t));
        console.log(`Rolling back "${collection}" to version ${target.version}:`);
        console.log(`  Current: ${activeTables.length} tables (version ${active?.version ?? '?'}, active)`);
        console.log(`  Target:  ${targetTables.length} tables (version ${target.version})`);
        console.log(`  Tables removed: ${removed.length > 0 ? removed.join(', ') : '(none)'}`);
        console.log(`  Tables added: ${added.length > 0 ? added.join(', ') : '(none)'}`);
        console.log('');
        const answer = await prompt(`Type the collection name to confirm: `);
        if (answer !== collection) { console.log('Rollback cancelled.'); break; }
      }

      const result = await client.rollback(conn, collection, flags.version);
      console.log(`Rolled back "${collection}" to version ${result.restored_version} (${result.table_count} tables).`);
      break;
    }

    case 'schema': {
      const sub = positional;
      if (sub === 'show') {
        const collection = positionals[1];
        if (!collection) fatal('NO_COLLECTION', 'No collection name provided.', 'Usage: vsql schema show <collection>');
        const conn = await resolveConn(flags);
        const active = await client.getActiveSchema(conn, collection);
        const tables = getTableNames(active.schema);
        console.log(`${collection} v${active.version} (${tables.length} tables, ${active.created_at})`);
        console.log('');
        console.log(JSON.stringify(active.schema, null, 2));
      } else if (sub === 'update') {
        const collection = positionals[1];
        if (!collection) fatal('NO_COLLECTION', 'No collection name provided.', 'Usage: vsql schema update <collection> --file schema.json');
        if (!flags.file) fatal('NO_FILE', 'No schema file provided.', 'Usage: vsql schema update <collection> --file schema.json');
        const conn = await resolveConn(flags);
        if (!flags['dry-run']) client.refuseDdlWithKey(conn, 'schema update');
        const newSchema = JSON.parse(readFileSync(flags.file, 'utf-8'));

        if (flags['dry-run'] || !flags.yes) {
          let currentTables: string[] = [];
          try {
            const current = await client.getActiveSchema(conn, collection);
            currentTables = getTableNames(current.schema);
          } catch { /* no existing schema */ }
          const newTables = getTableNames(newSchema);
          const removed = currentTables.filter(t => !newTables.includes(t));
          const added = newTables.filter(t => !currentTables.includes(t));
          console.log(`${flags['dry-run'] ? 'Dry-run' : 'Updating'}: "${collection}" schema`);
          console.log(`  Current: ${currentTables.length} tables`);
          console.log(`  New:     ${newTables.length} tables`);
          console.log(`  Tables added: ${added.length > 0 ? added.join(', ') : '(none)'}`);
          console.log(`  Tables removed: ${removed.length > 0 ? removed.join(', ') : '(none)'}`);
          if (flags['dry-run']) break;
          console.log('');
          const answer = await prompt(`Type the collection name to confirm: `);
          if (answer !== collection) { console.log('Update cancelled.'); break; }
        }

        const result = await client.updateSchema(conn, collection, newSchema);
        console.log(`Schema updated: "${collection}" (${result.table_count ?? getTableNames(newSchema).length} tables).`);
      } else {
        fatal('UNKNOWN_COMMAND', sub ? `Unknown command "schema ${sub}".` : "`vsql schema` needs a subcommand.", 'Usage: vsql schema <show|update> <collection>');
      }
      break;
    }

    case 'insert': {
      const collection = positional;
      const table = positionals[1];
      if (!collection || !table) fatal('MISSING_ARGS', 'Collection and table required.', 'Usage: vsql insert <collection> <table> --file doc.json');
      const conn = await resolveConn(flags);

      let docs: Record<string, unknown>[];
      if (flags.file) {
        const raw = JSON.parse(readFileSync(flags.file, 'utf-8'));
        docs = flags.batch && Array.isArray(raw) ? raw : [raw];
      } else if (flags.data) {
        docs = [JSON.parse(flags.data)];
      } else {
        fatal('NO_DATA', 'No data provided.', 'Use --file <path> or --data \'{"key":"value"}\'');
      }

      // v1.3.0: the tenant comes from the credential; --client-id is accepted for old scripts and ignored.
      let inserted = 0;
      for (const doc of docs) {
        const result = await client.insertDocument(conn, collection, table, doc);
        inserted++;
        if (!flags.batch || docs.length === 1) {
          console.log(`Inserted document${result.id != null ? ` (id: ${result.id})` : ''} into ${collection}.${table}`);
        }
      }
      if (flags.batch && docs.length > 1) {
        console.log(`Inserted ${inserted} documents into ${collection}.${table}`);
      }
      break;
    }

    // PAY-1975: row update/replace/delete on /v1/collections/{c}/tables/{t}/{id}. `data update|replace|delete`
    // (below, the 1.1.1 spelling) are aliases of these three - same args, same behavior.
    case 'update':
    case 'replace': {
      const collection = positional;
      const table = positionals[1];
      const id = positionals[2];
      const usage = `Usage: vsql ${command} <collection> <table> <id> --data '{"key":"value"}'`;
      if (!collection || !table || !id) fatal('MISSING_ARGS', 'Collection, table and id required.', usage);
      if (!flags.data) fatal('NO_DATA', 'No data provided.', usage);
      const doc = parseDataFlag(flags.data, usage);
      const conn = await resolveConn(flags);
      if (command === 'update') {
        await client.updateDocument(conn, collection, table, id, doc);
        console.log(`Updated ${collection}.${table} id=${id}.`);
      } else {
        await client.replaceDocument(conn, collection, table, id, doc);
        console.log(`Replaced ${collection}.${table} id=${id}.`);
      }
      break;
    }

    case 'delete': {
      const collection = positional;
      const table = positionals[1];
      const id = positionals[2];
      if (!collection || !table || !id) fatal('MISSING_ARGS', 'Collection, table and id required.', 'Usage: vsql delete <collection> <table> <id> [--yes]');
      if (!(await confirmDelete(collection, table, id, flags))) break;
      const conn = await resolveConn(flags);
      await client.deleteDocument(conn, collection, table, id);
      console.log(`Deleted ${collection}.${table} id=${id}.`);
      break;
    }

    // 1.1.1 compatibility: `vsql data update|replace|delete <collection> <table> <id> ...` - the ADO CLI's spelling,
    // kept so those docs/scripts still work. Same args, same behavior as the bare commands above.
    case 'data': {
      const sub = positional;
      if (sub !== 'update' && sub !== 'replace' && sub !== 'delete') {
        fatal('UNKNOWN_COMMAND', sub ? `Unknown command "data ${sub}".` : '`vsql data` needs a subcommand.', 'Usage: vsql data <update|replace|delete> <collection> <table> <id> ...');
      }
      const collection = positionals[1];
      const table = positionals[2];
      const id = positionals[3];
      const usage = `Usage: vsql data ${sub} <collection> <table> <id>${sub === 'delete' ? ' [--yes]' : ` --data '{"key":"value"}'`}`;
      if (!collection || !table || !id) fatal('MISSING_ARGS', 'Collection, table and id required.', usage);
      if (sub === 'delete') {
        if (!(await confirmDelete(collection, table, id, flags))) break;
        const conn = await resolveConn(flags);
        await client.deleteDocument(conn, collection, table, id);
        console.log(`Deleted ${collection}.${table} id=${id}.`);
        break;
      }
      if (!flags.data) fatal('NO_DATA', 'No data provided.', usage);
      const doc = parseDataFlag(flags.data, usage);
      const conn = await resolveConn(flags);
      if (sub === 'update') {
        await client.updateDocument(conn, collection, table, id, doc);
        console.log(`Updated ${collection}.${table} id=${id}.`);
      } else {
        await client.replaceDocument(conn, collection, table, id, doc);
        console.log(`Replaced ${collection}.${table} id=${id}.`);
      }
      break;
    }

    case 'login': {
      const profile = flags.profile ?? 'default';
      // --host is honored so the same login can target a non-default host.
      if (flags.host) setProfileHost(flags.host, profile);
      if (flags.passwordless || flags.email) {
        await loginPasswordless(profile, flags.passwordless ?? flags.email);
      } else {
        await loginDeviceCode(profile);
      }
      break;
    }

    case 'logout': {
      const profile = flags.profile ?? 'default';
      clearProfileAuth(profile);
      console.log(`Logged out. Tokens cleared for profile "${profile}".`);
      break;
    }

    case 'config': {
      const sub = positional;
      if (sub === 'init') {
        console.log('API-key init has been removed. Authenticate with the IDP instead:');
        console.log('');
        console.log('  vsql login                         # device-code flow (default)');
        console.log('  vsql login --passwordless <email>  # email passwordless flow');
        console.log('');
        console.log('Set host with `vsql config set host <url>` or the VSQL_HOST env var.');
      } else if (sub === 'set') {
        const setKey = args[args.indexOf('set') + 1];
        const setVal = args[args.indexOf('set') + 2];
        if (!setKey || !setVal) fatal('INVALID_ARGS', 'Usage: vsql config set host <value>');
        if (setKey !== 'host') fatal('INVALID_ARGS', `Cannot set "${setKey}". Only "host" is settable; tokens come from \`vsql login\`.`);
        setProfileHost(setVal, flags.profile);
        console.log(`Set host for profile "${flags.profile ?? 'default'}".`);
      } else if (sub === 'show') {
        showConfig();
      } else if (sub === 'clear') {
        clearConfig();
        console.log('Config cleared.');
      } else {
        fatal('UNKNOWN_COMMAND', sub ? `Unknown command "config ${sub}".` : "`vsql config` needs a subcommand.", 'Usage: vsql config <init|set|show|clear>');
      }
      break;
    }

    case 'health': {
      // PAY-1975 v1.3.2 (Vasanth intake, flaws 3+4): name the mode, host and credential SOURCE
      // (never the value) BEFORE the request - a stale saved profile or a shadowing env var is
      // then visible immediately, rather than reading as "healthy" for the wrong server.
      const src = describeHealthSource(flags);
      const conn = resolveHealthConn(flags);
      const target = conn.kind === 'key' ? `${conn.idp} (KeelBase ${conn.clientId})` : conn.host;
      const hostname = target.replace(/^https?:\/\//, '');
      // PAY-1978 MUST (rigpert 67321): name the client id's source and the key's source
      // SEPARATELY - they can differ (a Windows user-level VIBE_HMAC_KEY beating the shell's
      // while VIBE_CLIENT_ID still comes from the shell, exactly what bit Vasanth). A single
      // combined source hides a mismatch between the two.
      const modeLine = conn.kind === 'key'
        ? `mode: key-signing (client id from ${src.clientIdSource ?? 'env'}, key from ${src.keySource ?? 'env'})`
        : `mode: ${src.mode} (host from ${src.hostSource})`;
      console.error(modeLine);
      const result = await client.health(conn);
      const ver = result.version ? `, ${result.version}` : '';
      console.log(`${hostname}: ${result.status} (${result.latencyMs}ms${ver})`);
      break;
    }

    case 'version':
    case '--version':
    case '-v':
      console.log(`vsql v${VERSION}`);
      break;

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;

    default:
      // An unknown command used to print help and exit 0, so a typo looked like it ran (rigpert 63609).
      fatal('UNKNOWN_COMMAND', `Unknown command "${command}".`, 'Run `vsql help` for the list of commands.');
  }
}

function printHelp(): void {
      console.log(`vsql v${VERSION} — VibeSQL command-line interface

Usage: vsql <command> [options]

Commands:
  login                    Authenticate via IDP (device-code by default)
  logout                   Clear stored tokens from the profile
  query <sql>              Execute a SQL query (sign-in only)
  tables [collection]      List tables - one collection's, or all grouped by collection
  schemas                  List every collection and its active schema (including empty ones)
  describe <table>         Show column details for a table
  schema show <collection> Dump active JSON schema
  schema update <col>      Push schema from file
  insert <col> <table>     Insert documents
  update <col> <table> <id>   Merge-update a document (PATCH); alias: data update
  replace <col> <table> <id>  Whole-document replace (PUT); alias: data replace
  delete <col> <table> <id>   Delete a document; alias: data delete
  rows <col> <table>       Read a table's rows back (--page, --page-size)
  collections              List your collections (those with documents)
  rollback <collection>    Roll back a schema collection
  config <sub>             Manage connection profiles (init|set|show|clear)
  health                   Check server connectivity
  version                  Print CLI version

Options:
  --host <url>          VibeSQL server URL
  --profile <name>      Config profile to use (default: "default")
  --passwordless <email>  Log in via email passwordless flow (with login)
  --email <email>       Alias for --passwordless (with login)
  --format <fmt>        Output format: table, json, csv, raw
  --file <path>         Read SQL/schema/doc from a file
  --data <json>         Inline JSON for insert/update/replace
  --batch               Insert each element of a JSON array
  --page <n>            Page of rows to read (rows; default 1)
  --page-size <n>       Rows per page (rows; default 20)
  --dry-run             Show diff without applying
  --yes                 Skip confirmation prompt

Environment:
  VSQL_HOST             Default server URL
  VSQL_IDP_URL          IDP base URL (required for login/refresh)
  KEELBASE_CLIENT_ID    Your Tenant (the name your KeelBase page shows as "Tenant"); required for login/refresh
  VSQL_CLIENT_ID        Deprecated alias for KEELBASE_CLIENT_ID; still read, with a warning
  VIBE_CLIENT_ID        KeelBase client id (vibe_...) - key-signing, for app runtime calls
  VIBE_HMAC_KEY         KeelBase secret (base64) - key-signing; never pass it as an argument
  VSQL_DEBUG            Set to 1 to print each request's target to stderr (never a credential)

Key-signing (VIBE_CLIENT_ID + VIBE_HMAC_KEY set): calls go through the identity service
(VSQL_IDP_URL) signed with your KeelBase secret. It covers health, tables, schemas, rows,
collections, schema show, rollback --list, insert, update, replace and delete. query and schema
CHANGES (schema update, rollback) use your sign-in: run \`vsql login\` with the two variables unset.

Examples:
  vsql login
  vsql login --passwordless you@example.com
  vsql query "SELECT * FROM users LIMIT 5"
  vsql schemas
  vsql tables
  vsql tables vibe_agents
  vsql schema show vibe_agents
  vsql schema update vibe_agents --file schema.json
  vsql insert vibe_agents agents --file agent.json
  vsql update vibe_agents agents 243791 --data '{"city":"Chennai"}'
  vsql replace vibe_agents agents 243791 --data '{"city":"Chennai","name":"..."}'
  vsql delete vibe_agents agents 243791 --yes
  vsql rows vibe_agents agents --page-size 5
  vsql rollback my_schema --list`);
}

run();
