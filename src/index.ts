import { readFileSync } from 'fs';
import { createInterface } from 'readline';
import * as client from './client.js';
import { resolveConnection, getProfile, setProfileValue, showConfig, clearConfig } from './config.js';
import { formatRows, detectFormat, type Format } from './format.js';
import { fatal } from './errors.js';

const VERSION = '1.1.0';

interface Flags {
  host?: string;
  key?: string;
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
        if (key === 'version' || key === 'client-id') {
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

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, positionals, flags } = parseArgs(args);
  const positional = positionals[0] ?? '';

  switch (command) {
    case 'query': {
      const { host, key } = resolveConnection(flags);
      let sql = positional;
      if (flags.file) sql = readFileSync(flags.file, 'utf-8').trim();
      if (!sql) fatal('NO_QUERY', 'No SQL provided.', 'Pass SQL as argument or use --file.');
      const result = await client.query(host, key, sql);
      const rows = result.data ?? result.rows ?? [];
      const format = detectFormat(flags.format);
      const meta = result.meta ?? { rowCount: result.rowCount, executionTimeMs: result.executionTime };
      console.log(formatRows(rows, format, meta));
      break;
    }

    case 'tables': {
      const { host, key } = resolveConnection(flags);
      const schema = flags.schema ?? 'public';
      const sql = `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' ORDER BY table_name`;
      const result = await client.query(host, key, sql);
      const rows = result.data ?? result.rows ?? [];
      const format = detectFormat(flags.format);
      console.log(formatRows(rows, format));
      break;
    }

    case 'describe': {
      if (!positional) fatal('NO_TABLE', 'No table name provided.', 'Usage: vsql describe <table>');
      const { host, key } = resolveConnection(flags);
      const sql = `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = '${positional}' ORDER BY ordinal_position`;
      const result = await client.query(host, key, sql);
      const rows = result.data ?? result.rows ?? [];
      if (rows.length === 0) fatal('TABLE_NOT_FOUND', `Table "${positional}" not found or has no columns.`);
      const format = detectFormat(flags.format);
      console.log(formatRows(rows, format));
      break;
    }

    case 'rollback': {
      if (!positional) fatal('NO_COLLECTION', 'No collection name provided.', 'Usage: vsql rollback <collection>');
      const { host, key } = resolveConnection(flags);
      const collection = positional;

      if (flags.list) {
        const versions = await client.getVersions(host, key, collection);
        if (versions.length === 0) { console.log('No versions found.'); break; }
        for (const v of versions) {
          const tables = getTableNames(v.json_schema);
          const active = v.is_active ? ' (active)' : '';
          console.log(`  v${v.version}: ${tables.length} tables, ${v.created_at}${active}`);
        }
        break;
      }

      if (flags['dry-run']) {
        const versions = await client.getVersions(host, key, collection);
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
        const versions = await client.getVersions(host, key, collection);
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

      const result = await client.rollback(host, key, collection, flags.version);
      console.log(`Rolled back "${collection}" to version ${result.restored_version} (${result.table_count} tables).`);
      break;
    }

    case 'schema': {
      const sub = positional;
      if (sub === 'show') {
        const collection = positionals[1];
        if (!collection) fatal('NO_COLLECTION', 'No collection name provided.', 'Usage: vsql schema show <collection>');
        const { host, key } = resolveConnection(flags);
        const active = await client.getActiveSchema(host, key, collection);
        const tables = getTableNames(active.schema);
        console.log(`${collection} v${active.version} (${tables.length} tables, ${active.created_at})`);
        console.log('');
        console.log(JSON.stringify(active.schema, null, 2));
      } else if (sub === 'update') {
        const collection = positionals[1];
        if (!collection) fatal('NO_COLLECTION', 'No collection name provided.', 'Usage: vsql schema update <collection> --file schema.json');
        if (!flags.file) fatal('NO_FILE', 'No schema file provided.', 'Usage: vsql schema update <collection> --file schema.json');
        const { host, key } = resolveConnection(flags);
        const newSchema = JSON.parse(readFileSync(flags.file, 'utf-8'));

        if (flags['dry-run'] || !flags.yes) {
          let currentTables: string[] = [];
          try {
            const current = await client.getActiveSchema(host, key, collection);
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

        const clientId = flags['client-id'] ?? 0;
        const result = await client.updateSchema(host, key, collection, newSchema, clientId);
        console.log(`Schema updated: "${collection}" (${result.table_count ?? getTableNames(newSchema).length} tables).`);
      } else {
        console.log('Usage: vsql schema <show|update> <collection>');
      }
      break;
    }

    case 'insert': {
      const collection = positional;
      const table = positionals[1];
      if (!collection || !table) fatal('MISSING_ARGS', 'Collection and table required.', 'Usage: vsql insert <collection> <table> --file doc.json');
      const { host, key } = resolveConnection(flags);

      let docs: Record<string, unknown>[];
      if (flags.file) {
        const raw = JSON.parse(readFileSync(flags.file, 'utf-8'));
        docs = flags.batch && Array.isArray(raw) ? raw : [raw];
      } else if (flags.data) {
        docs = [JSON.parse(flags.data)];
      } else {
        fatal('NO_DATA', 'No data provided.', 'Use --file <path> or --data \'{"key":"value"}\'');
      }

      const clientId = flags['client-id'] ?? 0;
      let inserted = 0;
      for (const doc of docs) {
        const result = await client.insertDocument(host, key, collection, table, doc, clientId);
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

    case 'config': {
      const sub = positional;
      if (sub === 'init') {
        const host = await prompt('VibeSQL host: ');
        const key = await prompt('API key: ');
        const profile = flags.profile ?? 'default';
        if (host) setProfileValue('host', host, profile);
        if (key) setProfileValue('key', key, profile);
        console.log(`Config saved to ~/.vsql/config.json [${profile}]`);
      } else if (sub === 'set') {
        const setKey = args[args.indexOf('set') + 1] as 'host' | 'key';
        const setVal = args[args.indexOf('set') + 2];
        if (!setKey || !setVal) fatal('INVALID_ARGS', 'Usage: vsql config set <host|key> <value>');
        setProfileValue(setKey, setVal, flags.profile);
        console.log(`Set ${setKey} for profile "${flags.profile ?? 'default'}".`);
      } else if (sub === 'show') {
        showConfig();
      } else if (sub === 'clear') {
        clearConfig();
        console.log('Config cleared.');
      } else {
        console.log('Usage: vsql config <init|set|show|clear>');
      }
      break;
    }

    case 'health': {
      const profile = getProfile(flags.profile);
      const host = flags.host ?? process.env.VIBESQL_HOST ?? profile.host ?? 'http://localhost:52411';
      const result = await client.health(host);
      const hostname = host.replace(/^https?:\/\//, '');
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
    default:
      console.log(`vsql v${VERSION} — VibeSQL command-line interface

Usage: vsql <command> [options]

Commands:
  query <sql>              Execute a SQL query
  tables                   List all tables
  describe <table>         Show column details for a table
  schema show <collection> Dump active JSON schema
  schema update <col>      Push schema from file
  insert <col> <table>     Insert documents
  rollback <collection>    Roll back a schema collection
  config <sub>             Manage connection profiles (init|set|show|clear)
  health                   Check server connectivity
  version                  Print CLI version

Options:
  --host <url>          VibeSQL server URL
  --key <key>           API key (vsk_live_... or vsk_test_...)
  --profile <name>      Config profile to use (default: "default")
  --format <fmt>        Output format: table, json, csv, raw
  --file <path>         Read SQL/schema/doc from a file
  --data <json>         Inline JSON for insert
  --batch               Insert each element of a JSON array
  --dry-run             Show diff without applying
  --yes                 Skip confirmation prompt

Examples:
  vsql query "SELECT * FROM users LIMIT 5"
  vsql schema show vibe_agents
  vsql schema update vibe_agents --file schema.json
  vsql insert vibe_agents agents --file agent.json
  vsql rollback my_schema --list
  vsql config init`);
      break;
  }
}

run();
