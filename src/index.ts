import { readFileSync } from 'fs';
import { createInterface } from 'readline';
import * as client from './client.js';
import {
  resolveConn,
  resolveHealthConn,
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
  type Profile,
} from './config.js';
import { formatRows, detectFormat, type Format } from './format.js';
import { fatal } from './errors.js';

const VERSION = '1.3.0';

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

function parseArgs(argv: string[]): { command: string; positionals: string[]; flags: Flags } {
  const command = argv[0] ?? 'help';
  const flags: Flags = {};
  const positionals: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'dry-run' || key === 'list' || key === 'yes' || key === 'batch') {
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
  const args = process.argv.slice(2);
  const { command, positionals, flags } = parseArgs(args);
  const positional = positionals[0] ?? '';

  switch (command) {
    case 'query': {
      const conn = await resolveConn(flags);
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
      const conn = await resolveConn(flags);
      const schema = flags.schema ?? 'public';
      const sql = `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' ORDER BY table_name`;
      const result = await client.query(conn, sql);
      const rows = result.data ?? result.rows ?? [];
      const format = detectFormat(flags.format);
      console.log(formatRows(rows, format));
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
      const conn = resolveHealthConn(flags);
      const result = await client.health(conn);
      const target = conn.kind === 'key' ? `${conn.idp} (KeelBase ${conn.clientId})` : conn.host;
      const hostname = target.replace(/^https?:\/\//, '');
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
  query <sql>              Execute a SQL query
  tables                   List all tables
  describe <table>         Show column details for a table
  schema show <collection> Dump active JSON schema
  schema update <col>      Push schema from file
  insert <col> <table>     Insert documents
  rows <col> <table>       Read a table's rows back (--page, --page-size)
  collections              List your collections
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
  --data <json>         Inline JSON for insert
  --batch               Insert each element of a JSON array
  --page <n>            Page of rows to read (rows; default 1)
  --page-size <n>       Rows per page (rows; default 20)
  --dry-run             Show diff without applying
  --yes                 Skip confirmation prompt

Environment:
  VSQL_HOST             Default server URL
  VSQL_IDP_URL          IDP base URL (required for login/refresh)
  VSQL_CLIENT_ID        IDP OAuth client id (required for login/refresh)
  VIBE_CLIENT_ID        KeelBase client id (vibe_...) - key-signing, for app runtime calls
  VIBE_HMAC_KEY         KeelBase secret (base64) - key-signing; never pass it as an argument
  VSQL_DEBUG            Set to 1 to print each request's target to stderr (never a credential)

Key-signing (VIBE_CLIENT_ID + VIBE_HMAC_KEY set): calls go through the identity service
(VSQL_IDP_URL) signed with your KeelBase secret. It covers query, health, rows, collections,
schema show, rollback --list and insert. Schema changes (schema update, rollback) use your sign-in:
run \`vsql login\` with the two variables unset.

Examples:
  vsql login
  vsql login --passwordless you@example.com
  vsql query "SELECT * FROM users LIMIT 5"
  vsql schema show vibe_agents
  vsql schema update vibe_agents --file schema.json
  vsql insert vibe_agents agents --file agent.json
  vsql rows vibe_agents agents --page-size 5
  vsql rollback my_schema --list`);
}

run();
