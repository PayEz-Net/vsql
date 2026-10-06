// v1.3.4 (PAY-2052): `describe <table> [collection]` reads the active schema (GET /v1/schemas) instead of
// information_schema through the raw SQL route, which the hosted API refuses for tenant keys (403, Scout 69424).
// Reads dist (what ships). The CLI rows spawn the real bin against a local stand-in for the identity service proxy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeTable } from '../dist/describe.js';

const TEST_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const CLIENT = 'vibe_25c8bbf4cd37c521';

const ver = (collection, tables, is_active = true) => ({ collection_schema_id: 1, collection, json_schema: { tables }, version: 1, is_active, created_at: '2026-10-06T00:00:00Z' });
const NOTES = {
  type: 'object',
  required: ['id', 'title'],
  properties: {
    id: { type: 'integer', 'x-vibe-pk': true, 'x-vibe-auto-increment': true },
    title: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
};

test('describeTable: name, type, format, pk, auto-increment; nullable is "not in required"', () => {
  const r = describeTable([ver('app', { notes: NOTES })], 'notes');
  assert.equal(r.collection, 'app');
  assert.deepEqual(r.rows, [
    { column_name: 'id', type: 'integer', format: '', pk: 'yes', auto_increment: 'yes', nullable: 'NO' },
    { column_name: 'title', type: 'string', format: '', pk: '', auto_increment: '', nullable: 'NO' },
    { column_name: 'created_at', type: 'string', format: 'date-time', pk: '', auto_increment: '', nullable: 'YES' },
  ]);
});
test('describeTable: a table with no `required` array has every column nullable', () => {
  const r = describeTable([ver('app', { t: { properties: { a: { type: 'string' } } } })], 't');
  assert.equal(r.rows[0].nullable, 'YES');
});
test('describeTable: an inactive schema version is not read', () => {
  assert.equal(describeTable([ver('app', { notes: NOTES }, false)], 'notes').code, 'TABLE_NOT_FOUND');
});
test('describeTable: the same table in two collections is AMBIGUOUS and names both; a collection argument picks one', () => {
  const s = [ver('a', { notes: NOTES }), ver('b', { notes: NOTES })];
  const amb = describeTable(s, 'notes');
  assert.equal(amb.code, 'AMBIGUOUS_TABLE');
  assert.match(amb.message, /a, b/);
  assert.match(amb.hint, /vsql describe notes <collection>/);
  assert.equal(describeTable(s, 'notes', 'b').collection, 'b');
});
test('describeTable: unknown collection and table-not-in-that-collection are separate errors', () => {
  const s = [ver('a', { notes: NOTES }), ver('b', {})];
  assert.equal(describeTable(s, 'notes', 'zzz').code, 'COLLECTION_NOT_FOUND');
  assert.equal(describeTable(s, 'notes', 'b').code, 'TABLE_NOT_FOUND');
  assert.equal(describeTable(s, 'nope').code, 'TABLE_NOT_FOUND');
});
test('describeTable: a name like "constructor" is not found by prototype lookup', () => {
  assert.equal(describeTable([ver('a', { notes: NOTES })], 'constructor').code, 'TABLE_NOT_FOUND');
});

// -- the real CLI against a stand-in proxy -----------------------------------------------------------------------------
async function runDescribe(args, schemas) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url, endpoint: body.endpoint, method: body.method });
      res.setHeader('Content-Type', 'application/json');
      if (body.endpoint === '/v1/schemas') {
        res.end(JSON.stringify({ success: true, data: schemas.map(s => ({ collectionSchemaId: 1, collection: s.collection, jsonSchema: JSON.stringify(s.json_schema), version: 1, isActive: s.is_active, createdAt: s.created_at })) }));
      } else {
        res.statusCode = 403; // the raw SQL route: what describe used to call
        res.end(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'raw sql refused' } }));
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(join(tmpdir(), 'vsql-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, VIBE_CLIENT_ID: CLIENT, VIBE_HMAC_KEY: TEST_SECRET, VSQL_IDP_URL: `http://127.0.0.1:${server.address().port}` };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/vsql.js', import.meta.url)), ...args], { env });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => (stdout += d));
  child.stderr.on('data', d => (stderr += d));
  const status = await new Promise(r => child.on('close', r));
  server.close();
  rmSync(home, { recursive: true, force: true });
  return { status, stdout, stderr, seen };
}

test('cli: describe in key mode prints the columns from GET /v1/schemas and never touches the raw SQL route', async () => {
  const r = await runDescribe(['describe', 'notes', '--format', 'json'], [ver('app', { notes: NOTES })]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.seen.map(s => [s.method, s.endpoint]), [['GET', '/v1/schemas']]);
  const rows = JSON.parse(r.stdout);
  assert.deepEqual(rows.map(x => x.column_name), ['id', 'title', 'created_at']);
  assert.equal(rows[0].pk, 'yes');
  assert.equal(rows[2].format, 'date-time');
});
test('cli: describe <table> <collection> picks the collection; an ambiguous name without one exits non-zero with AMBIGUOUS_TABLE', async () => {
  const s = [ver('a', { notes: NOTES }), ver('b', { notes: { properties: { only_b: { type: 'string' } } } })];
  const ok = await runDescribe(['describe', 'notes', 'b', '--format', 'json'], s);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).map(x => x.column_name), ['only_b']);
  const amb = await runDescribe(['describe', 'notes'], s);
  assert.notEqual(amb.status, 0);
  assert.match(amb.stderr, /AMBIGUOUS_TABLE/);
  assert.match(amb.stderr, /a, b/);
  assert.equal(amb.stdout.trim(), '', 'nothing printed as if one had been described');
});
test('cli: an unknown table exits non-zero with TABLE_NOT_FOUND', async () => {
  const r = await runDescribe(['describe', 'nope'], [ver('app', { notes: NOTES })]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TABLE_NOT_FOUND/);
});
test('cli: describe with no table still says NO_TABLE, before any request', async () => {
  const r = await runDescribe(['describe'], []);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /NO_TABLE/);
  assert.equal(r.seen.length, 0);
});
