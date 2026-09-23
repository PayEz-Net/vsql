// v1.3.0 (PAY-1738): the CLI against the HOSTED VibeSQL API's recorded contract (PayEz-Core source, measured on dev-93 by
// rigpert 63518), plus key-signing through the identity service's proxy. Reads dist (what ships): `npm test` builds first.
//
// Each route test pins what v1.2.0 got wrong. The mutation run that proves each one bites (put the v1.2.0 route/body back
// -> that test goes RED) is recorded in the PR.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as client from '../dist/client.js';
import { signProxyRequest, decodeSecret } from '../dist/signing.js';
import { keyCredentials } from '../dist/config.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Scout's TEST key (bytes 0x00..0x1f) and the verifier's own vectors (DotNetPert-Scout 63513, computed by
// VibeProxyController.ComputeHmacSignature). Never a real secret.
const TEST_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const JWT = 'aaa.bbb.ccc';
const HOST = 'https://vibe.test';
const IDP = 'https://idp.test';
const BEARER = { kind: 'bearer', host: HOST, token: JWT };
const KEY = { kind: 'key', idp: IDP, clientId: 'vibe_25c8bbf4cd37c521', secret: TEST_SECRET };

class Exit extends Error { constructor(code) { super(`exit ${code}`); this.code = code; } }
let calls, replies, stderr, saved;

/** Queue a reply for the next fetch: a JSON body, or a raw string body. */
function reply(status, body, statusText = '') {
  replies.push(() => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, statusText }));
}

beforeEach(() => {
  calls = []; replies = []; stderr = '';
  saved = { fetch: globalThis.fetch, exit: process.exit, write: process.stderr.write, env: { ...process.env } };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const next = replies.shift();
    if (!next) throw new Error('no reply queued');
    return next();
  };
  process.exit = (code) => { throw new Exit(code); };
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  for (const k of ['VIBE_CLIENT_ID', 'VIBE_HMAC_KEY', 'VSQL_IDP_URL', 'IDP_URL', 'VSQL_DEBUG']) delete process.env[k];
});
afterEach(() => {
  globalThis.fetch = saved.fetch; process.exit = saved.exit; process.stderr.write = saved.write; process.env = saved.env;
});

async function expectExit(fn, code) {
  await assert.rejects(fn, (e) => e instanceof Exit);
  assert.match(stderr, new RegExp(`Error \\[${code}\\]`), `expected error ${code}, stderr was: ${stderr}`);
}

// ── signing: the verifier's own vectors ────────────────────────────────────────────────────────────────────────────
test('signing: vector 1 (POST /v1/mvp/query) matches the IdP proxy verifier', () => {
  assert.equal(signProxyRequest(TEST_SECRET, 1769131200, 'POST', '/v1/mvp/query'), 'GIE2XYqA04iZ/0HedDPOwUe5QHsfzyUjaKREWYpdaGQ=');
});
test('signing: vector 2 (GET /v1/collections) matches the IdP proxy verifier', () => {
  assert.equal(signProxyRequest(TEST_SECRET, 1769131200, 'GET', '/v1/collections'), 'rMvh+4vcTGeorJqpPPIR5o/pQGJn0+k6juKStgYR0vE=');
});
test('signing: the method is upper-cased, as the verifier does (request.Method.ToUpperInvariant)', () => {
  assert.equal(signProxyRequest(TEST_SECRET, 1769131200, 'get', '/v1/collections'), 'rMvh+4vcTGeorJqpPPIR5o/pQGJn0+k6juKStgYR0vE=');
});
test('signing: the secret is decoded STRICTLY, like Convert.FromBase64String (a typo is caught here, not as a mismatch)', () => {
  assert.equal(decodeSecret(TEST_SECRET).length, 32);
  for (const bad of ['', 'not base64!', TEST_SECRET.slice(0, -1), TEST_SECRET.replace('A', '-'), 'AAAA']) {
    assert.throws(() => decodeSecret(bad), `rejects ${JSON.stringify(bad)}`);
  }
});

// ── routes, bearer (the primary path: `vsql login`) ─────────────────────────────────────────────────────────────────
test('query: POST /v1/vsql/query with { sql } (v1.2.0 called /v1/query, which is 404 on the API)', async () => {
  reply(200, { success: true, data: [{ n: 1 }], meta: { rowCount: 1 } });
  const r = await client.query(BEARER, 'select 1 as n');
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['POST', `${HOST}/v1/vsql/query`]]);
  assert.deepEqual(calls[0].body, { sql: 'select 1 as n' });
  assert.equal(calls[0].headers.Authorization, `Bearer ${JWT}`);
  assert.deepEqual(r.data, [{ n: 1 }]);
});
test("query: the API's own refusal (read-only until RLS) is surfaced with its code, not invented", async () => {
  reply(403, { success: false, error: { code: 'FORBIDDEN', message: 'Writes go through the data endpoints' } });
  await expectExit(() => client.query(BEARER, 'insert into t values (1)'), 'FORBIDDEN');
  assert.match(stderr, /Writes go through the data endpoints/);
});
test('schema update: POST /v1/schemas/{c} with jsonSchema as an OBJECT (v1.2.0: PUT -> 405, a string -> 400 NOT_OBJECT)', async () => {
  reply(201, { success: true, data: { version: 2, tableCount: 1 } });
  const schema = { tables: { notes: { columns: { title: { type: 'string' } } } } };
  const r = await client.updateSchema(BEARER, 'keelbase_demo', schema);
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['POST', `${HOST}/v1/schemas/keelbase_demo`]]);
  assert.deepEqual(calls[0].body, { jsonSchema: schema });
  assert.equal(typeof calls[0].body.jsonSchema, 'object');
  assert.equal(r.version, 2);
});
test('insert: the body IS the document (v1.2.0 wrapped it as { clientId, data: "<string>" } -> 400 REQUIRED_FIELDS_MISSING)', async () => {
  reply(201, { success: true, data: { document_id: 41, collection: 'keelbase_demo' }, generatedKeys: {} });
  const doc = { title: 'hello' };
  const r = await client.insertDocument(BEARER, 'keelbase_demo', 'notes', doc);
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['POST', `${HOST}/v1/collections/keelbase_demo/tables/notes`]]);
  assert.deepEqual(calls[0].body, doc);
  assert.equal(r.id, 41);
});
test('schema show: the API answers camelCase (isActive / jsonSchema / createdAt) - v1.2.0 read snake_case -> NO_ACTIVE_SCHEMA', async () => {
  reply(200, { success: true, data: [
    { collectionSchemaId: 7, clientId: 45, collection: 'keelbase_demo', jsonSchema: '{"tables":{"notes":{}}}', version: 1, isActive: true, createdAt: '2026-09-23T13:20:00Z' },
  ] });
  const a = await client.getActiveSchema(BEARER, 'keelbase_demo');
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['GET', `${HOST}/v1/schemas/keelbase_demo/versions`]]);
  assert.equal(a.version, 1);
  assert.deepEqual(a.schema, { tables: { notes: {} } });
});
test('rollback: POST /v1/schemas/{c}/rollback with { targetVersion }', async () => {
  reply(200, { success: true, data: { collection: 'keelbase_demo', restoredVersion: 1, tableCount: 1, message: 'ok' } });
  const r = await client.rollback(BEARER, 'keelbase_demo', 1);
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['POST', `${HOST}/v1/schemas/keelbase_demo/rollback`]]);
  assert.deepEqual(calls[0].body, { targetVersion: 1 });
  assert.equal(r.restored_version, 1);
});
test('health: the public /health probe, plain-text answer accepted', async () => {
  reply(200, 'Healthy');
  const r = await client.health({ kind: 'anon', host: HOST });
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['GET', `${HOST}/health`]]);
  assert.equal(calls[0].headers.Authorization, undefined, 'health sends no credential');
  assert.equal(r.status, 'Healthy');
});
test('a non-JSON or empty reply prints the HTTP status and what came back - never a raw SyntaxError stack', async () => {
  reply(502, '<html>Bad Gateway</html>', 'Bad Gateway');
  await expectExit(() => client.query(BEARER, 'select 1'), 'BAD_RESPONSE');
  assert.match(stderr, /HTTP 502/);
  assert.doesNotMatch(stderr, /SyntaxError/);
  stderr = '';
  reply(404, '');
  await expectExit(() => client.getVersions(BEARER, 'x'), 'BAD_RESPONSE');
  assert.match(stderr, /HTTP 404.*empty body/);
});

// ── key-signing (optional: app runtime calls with the KeelBase client id + secret) ───────────────────────────────────
test('key-signing: POST {IdP}/api/vibe/proxy with { endpoint, method, data } and a signature the verifier accepts', async () => {
  reply(200, { success: true, data: [] });
  const before = Math.floor(Date.now() / 1000);
  await client.query(KEY, 'select 1');
  const c = calls[0];
  assert.equal(c.url, `${IDP}/api/vibe/proxy`);
  assert.equal(c.method, 'POST');
  assert.deepEqual(c.body, { endpoint: '/v1/vsql/query', method: 'POST', data: { sql: 'select 1' } });
  assert.equal(c.headers['X-Vibe-Client-Id'], KEY.clientId);
  const ts = Number(c.headers['X-Vibe-Timestamp']);
  assert.ok(ts >= before && ts <= before + 5, 'timestamp is unix seconds, now');
  // Recompute exactly as VibeProxyController does and compare.
  const expected = createHmac('sha256', Buffer.from(TEST_SECRET, 'base64')).update(`${ts}|POST|/v1/vsql/query`).digest('base64');
  assert.equal(c.headers['X-Vibe-Signature'], expected);
});
test('key-signing: the secret never leaves the machine - not in the URL, a header or the body', async () => {
  reply(200, { success: true, data: [] });
  await client.query(KEY, 'select 1');
  const wire = JSON.stringify(calls);
  assert.ok(!wire.includes(TEST_SECRET), 'the base64 secret is not on the wire');
  assert.ok(!wire.includes(decodeSecret(TEST_SECRET).toString('hex')), 'nor its bytes in hex');
});
test('key-signing: schema changes (DDL) are refused with the secret and point at `vsql login` - nothing is sent (Jon, 63518)', async () => {
  await expectExit(() => client.updateSchema(KEY, 'keelbase_demo', { tables: {} }), 'NOT_WITH_KEELBASE_SECRET');
  assert.match(stderr, /vsql login/);
  stderr = '';
  await expectExit(() => client.rollback(KEY, 'keelbase_demo', 1), 'NOT_WITH_KEELBASE_SECRET');
  assert.equal(calls.length, 0, 'no request was made');
});
test('key-signing: runtime row writes (insert) are allowed with the secret, through the proxy', async () => {
  reply(201, { success: true, data: { document_id: 5 } });
  await client.insertDocument(KEY, 'keelbase_demo', 'notes', { title: 'x' });
  assert.deepEqual(calls[0].body, { endpoint: '/v1/collections/keelbase_demo/tables/notes', method: 'POST', data: { title: 'x' } });
});
test('key-signing: VSQL_DEBUG output names the endpoint and client id, never the secret', async () => {
  process.env.VSQL_DEBUG = '1';
  reply(200, { success: true, data: [] });
  await client.query(KEY, 'select 1');
  assert.match(stderr, /\[vsql\] key-signing: POST https:\/\/idp\.test\/api\/vibe\/proxy endpoint=\/v1\/vsql\/query/);
  assert.ok(!stderr.includes(TEST_SECRET), 'no secret in debug output');
  assert.ok(!stderr.includes(calls[0].headers['X-Vibe-Signature']), 'no signature in debug output either');
});

// ── configuration: the env pair ────────────────────────────────────────────────────────────────────────────────────
test('config: key-signing only from the environment pair; half a pair fails loud; neither -> login mode', async () => {
  assert.equal(keyCredentials(), null, 'neither set -> null (login mode)');
  process.env.VIBE_CLIENT_ID = KEY.clientId;
  await expectExit(async () => keyCredentials(), 'INCOMPLETE_KEY');
  stderr = '';
  process.env.VIBE_HMAC_KEY = TEST_SECRET;
  await expectExit(async () => keyCredentials(), 'NO_IDP_URL');
  process.env.IDP_URL = 'https://idp.test/';
  assert.deepEqual(keyCredentials(), { idp: 'https://idp.test', clientId: KEY.clientId, secret: TEST_SECRET });
  stderr = '';
  process.env.VIBE_CLIENT_ID = 'not-a-vibe-id';
  await expectExit(async () => keyCredentials(), 'INVALID_CLIENT_ID');
  assert.ok(!stderr.includes(TEST_SECRET), 'no error message echoes the secret');
});

// ── rows / collections: reading data back (rigpert 63609, first-impressions run on prod) ─────────────────────────────
test('rows: GET /v1/collections/{c}/tables/{t}?page&pageSize, each row is data[].data (object or JSON string) with its document_id', async () => {
  reply(200, { success: true, data: [{ document_id: 7, data: { title: 'a' } }, { document_id: 8, data: '{"title":"b"}' }], pagination: { totalCount: 12 } });
  const r = await client.listRows(BEARER, 'vibe_agents', 'agents', 2, 5);
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['GET', `${HOST}/v1/collections/vibe_agents/tables/agents?page=2&pageSize=5`]]);
  assert.equal(calls[0].body, undefined, 'a GET carries no body');
  assert.deepEqual(r.rows, [{ document_id: 7, title: 'a' }, { document_id: 8, title: 'b' }]);
  assert.equal(r.total, 12);
});
test('rows: defaults to page 1, 20 per page; the API refusal is surfaced with its code', async () => {
  reply(404, { success: false, error: { code: 'TABLE_NOT_FOUND', message: 'no such table' } });
  await expectExit(() => client.listRows(BEARER, 'c', 't'), 'TABLE_NOT_FOUND');
  assert.equal(calls[0].url, `${HOST}/v1/collections/c/tables/t?page=1&pageSize=20`);
});
test('collections: GET /v1/collections; a bare array or { collections: [...] } both read', async () => {
  reply(200, { success: true, data: [{ collection: 'vibe_agents' }] });
  assert.deepEqual(await client.listCollections(BEARER), [{ collection: 'vibe_agents' }]);
  reply(200, { success: true, data: { collections: [{ collection: 'x' }] } });
  assert.deepEqual(await client.listCollections(BEARER), [{ collection: 'x' }]);
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['GET', `${HOST}/v1/collections`], ['GET', `${HOST}/v1/collections`]]);
});
test('key-signing: rows and collections go through the proxy as signed GETs (read-only, allowed with the secret)', async () => {
  reply(200, { success: true, data: [] });
  reply(200, { success: true, data: [] });
  await client.listRows(KEY, 'vibe_agents', 'agents');
  await client.listCollections(KEY);
  assert.deepEqual(calls.map(c => [c.url, c.body.method, c.body.endpoint, c.body.data]), [
    [`${IDP}/api/vibe/proxy`, 'GET', '/v1/collections/vibe_agents/tables/agents?page=1&pageSize=20', null],
    [`${IDP}/api/vibe/proxy`, 'GET', '/v1/collections', null],
  ]);
  const c = calls[1];
  const expected = createHmac('sha256', Buffer.from(TEST_SECRET, 'base64')).update(`${c.headers['X-Vibe-Timestamp']}|GET|/v1/collections`).digest('base64');
  assert.equal(c.headers['X-Vibe-Signature'], expected);
});

// ── the CLI itself, spawned: exit codes and config show (rigpert 63609) ──────────────────────────────────────────────
function cli(args, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vsql-home-'));
  const env = { ...saved.env, HOME: home, USERPROFILE: home, ...extraEnv };
  for (const k of ['VIBE_CLIENT_ID', 'VIBE_HMAC_KEY', 'VSQL_DEBUG']) if (!(k in extraEnv)) delete env[k];
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/vsql.js', import.meta.url)), ...args], { env, encoding: 'utf8' });
  rmSync(home, { recursive: true, force: true });
  return r;
}
test('cli: an unknown command exits non-zero and says so (it printed help and exited 0, so a typo looked like it ran)', () => {
  const r = cli(['rowz']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown command.*rowz/i);
  assert.equal(cli(['help']).status, 0, 'help itself still exits 0');
  assert.equal(cli([]).status, 0, 'no command prints help, exit 0');
});
test('cli: config show in key-signing mode does not tell the developer to run `vsql login`', () => {
  const r = cli(['config', 'show'], { VIBE_CLIENT_ID: 'vibe_25c8bbf4cd37c521', VIBE_HMAC_KEY: TEST_SECRET });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /key-signing/);
  assert.doesNotMatch(r.stdout, /No config found/);
  assert.match(r.stdout, /not needed for key-signing/);
  assert.ok(!r.stdout.includes(TEST_SECRET) && !r.stderr.includes(TEST_SECRET), 'the secret is never printed');
  assert.match(cli(['config', 'show']).stdout, /No config found\. Run `vsql login`/, 'without a key the hint stays');
});
test('cli: an unknown flag fails loud (rigpert 63618: `rows --limit 3` silently ate --limit and its value)', () => {
  const r = cli(['rows', 'c', 't', '--limit', '3']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /UNKNOWN_FLAG.*--limit/);
  assert.match(r.stderr, /--page-size/, 'the hint names the flag they probably meant');
  assert.equal(calls.length, 0);
  assert.equal(cli(['query', '--help']).status, 0, '--help after a command still shows help');
  const ok = cli(['version', '--profile', 'x']);
  assert.equal(ok.status, 0, 'a known flag still works');
});
