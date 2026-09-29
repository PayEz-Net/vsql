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
import { keyCredentials, loadDotEnv, envSource, describeHealthSource } from '../dist/config.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** Queue a reply with NO body - for null-body statuses (204/205/304), where the Fetch spec forbids any body,
 *  even an empty string (`new Response('', {status:204})` throws). */
function replyEmpty(status) {
  replies.push(() => new Response(null, { status }));
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
// ── PAY-1978: listSchemas() - GET /v1/schemas (bare), NOT /v1/enterprise/schemas ────────────────────────────────────
test('listSchemas: exactly one GET /v1/schemas, parses the same camelCase DTO shape as getVersions', async () => {
  reply(200, { success: true, data: [
    { collectionSchemaId: 1, collection: 'vibe_agents', jsonSchema: '{"tables":{"agents":{}}}', version: 2, isActive: true, createdAt: '2026-09-29T00:00:00Z' },
    { collectionSchemaId: 2, collection: 'vibe_app', jsonSchema: '{"tables":{}}', version: 1, isActive: true, createdAt: '2026-09-29T00:00:00Z' },
  ] });
  const schemas = await client.listSchemas(BEARER);
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['GET', `${HOST}/v1/schemas`]]);
  assert.equal(calls[0].body, undefined, 'a GET carries no body');
  assert.equal(schemas.length, 2);
  assert.equal(schemas[0].collection, 'vibe_agents');
  assert.deepEqual(schemas[0].json_schema, { tables: { agents: {} } });
  assert.equal(schemas[0].is_active, true);
});
test('key-signing: listSchemas signs GET /v1/schemas through the proxy like other key-mode reads - no X-Vibe-Client-Secret header (the whole point of using /v1/schemas, not /v1/enterprise/schemas)', async () => {
  reply(200, { success: true, data: [] });
  await client.listSchemas(KEY);
  const c = calls[0];
  assert.equal(c.body.endpoint, '/v1/schemas');
  assert.equal(c.body.method, 'GET');
  assert.equal(c.body.data, null);
  assert.equal(c.headers['X-Vibe-Client-Secret'], undefined, 'vsql never sends a client secret - this is the whole point of using /v1/schemas, not /v1/enterprise/schemas');
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

// ── PAY-1975: update / replace / delete a row (measured on the dev-93 twin, rigpert 67270) ────────────────────────────
test('update: PATCH /v1/collections/{c}/tables/{t}/{id} with the patch as the body, path segments encoded', async () => {
  reply(200, { success: true, data: { document_id: 41 } });
  await client.updateDocument(BEARER, 'keelbase demo', 'notes', 41, { city: 'Chennai' });
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['PATCH', `${HOST}/v1/collections/keelbase%20demo/tables/notes/41`]]);
  assert.deepEqual(calls[0].body, { city: 'Chennai' });
  assert.equal(calls[0].headers.Authorization, `Bearer ${JWT}`);
});
test('replace: PUT /v1/collections/{c}/tables/{t}/{id} with the whole document as the body', async () => {
  reply(200, { success: true, data: { document_id: 41 } });
  await client.replaceDocument(BEARER, 'keelbase_demo', 'notes', 41, { title: 'new', city: 'Chennai' });
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['PUT', `${HOST}/v1/collections/keelbase_demo/tables/notes/41`]]);
  assert.deepEqual(calls[0].body, { title: 'new', city: 'Chennai' });
});
test('delete: DELETE /v1/collections/{c}/tables/{t}/{id}, a 204 with no body does not throw (readJson would fatal() on an unparseable empty body)', async () => {
  replyEmpty(204);
  await client.deleteDocument(BEARER, 'keelbase_demo', 'notes', 41);
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['DELETE', `${HOST}/v1/collections/keelbase_demo/tables/notes/41`]]);
  assert.equal(calls[0].body, undefined, 'DELETE carries no body');
});
test('delete: a non-204 failure (404 NOT_FOUND) still surfaces the API error, not swallowed as success', async () => {
  reply(404, { success: false, error: { code: 'NOT_FOUND', message: 'no such row' } });
  await expectExit(() => client.deleteDocument(BEARER, 'keelbase_demo', 'notes', 999), 'NOT_FOUND');
});
test('update/replace/delete: the string id is URL-encoded like collection/table (a UUID-ish id with special chars round-trips)', async () => {
  reply(200, { success: true, data: {} });
  await client.updateDocument(BEARER, 'c', 't', 'a/b c', { x: 1 });
  assert.equal(calls[0].url, `${HOST}/v1/collections/c/tables/t/${encodeURIComponent('a/b c')}`);
});
test('key-signing: update/replace/delete are allowed with the secret, through the proxy, with the right method each', async () => {
  reply(200, { success: true, data: {} });
  reply(200, { success: true, data: {} });
  replyEmpty(204);
  await client.updateDocument(KEY, 'c', 't', 41, { a: 1 });
  await client.replaceDocument(KEY, 'c', 't', 41, { a: 1 });
  await client.deleteDocument(KEY, 'c', 't', 41);
  assert.deepEqual(calls.map(c => [c.body.method, c.body.endpoint, c.body.data]), [
    ['PATCH', '/v1/collections/c/tables/t/41', { a: 1 }],
    ['PUT', '/v1/collections/c/tables/t/41', { a: 1 }],
    ['DELETE', '/v1/collections/c/tables/t/41', null],
  ]);
});

// ── PAY-1975 v1.3.2 (Vasanth intake): .env loading, source naming, key-mode query refusal ──────────────────────────
test('loadDotEnv: reads .env from the given cwd into process.env, and envSource reports it as .env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsql-dotenv-'));
  writeFileSync(join(dir, '.env'), 'VSQL_TEST_A=hello\nVSQL_TEST_B="quoted value"\n# a comment\n\nVSQL_TEST_C=\'single quoted\'\n');
  try {
    loadDotEnv(dir);
    assert.equal(process.env.VSQL_TEST_A, 'hello');
    assert.equal(process.env.VSQL_TEST_B, 'quoted value', 'double quotes stripped');
    assert.equal(process.env.VSQL_TEST_C, 'single quoted', 'single quotes stripped');
    assert.equal(envSource('VSQL_TEST_A'), '.env');
  } finally {
    delete process.env.VSQL_TEST_A; delete process.env.VSQL_TEST_B; delete process.env.VSQL_TEST_C;
    rmSync(dir, { recursive: true, force: true });
  }
});
test('loadDotEnv: NEVER overrides a real env var already set, and envSource reports THAT as env not .env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsql-dotenv-'));
  writeFileSync(join(dir, '.env'), 'VSQL_TEST_D=from-dotenv\n');
  process.env.VSQL_TEST_D = 'from-real-env';
  try {
    loadDotEnv(dir);
    assert.equal(process.env.VSQL_TEST_D, 'from-real-env', 'the real env var won, unchanged');
    assert.equal(envSource('VSQL_TEST_D'), 'env');
  } finally {
    delete process.env.VSQL_TEST_D;
    rmSync(dir, { recursive: true, force: true });
  }
});
test('loadDotEnv: a missing .env is not an error; malformed lines are skipped, not fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsql-dotenv-'));
  try {
    assert.doesNotThrow(() => loadDotEnv(dir)); // no .env at all
    writeFileSync(join(dir, '.env'), 'not a valid line\n=starts with equals\nVSQL_TEST_E=ok\n123INVALID=nope\n');
    loadDotEnv(dir);
    assert.equal(process.env.VSQL_TEST_E, 'ok', 'the one well-formed line still loaded');
    assert.equal(process.env['123INVALID'], undefined, 'a non-identifier key is skipped');
  } finally {
    delete process.env.VSQL_TEST_E;
    rmSync(dir, { recursive: true, force: true });
  }
});
test('describeHealthSource: names key-signing + which var supplied the client id (env vs .env)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsql-dotenv-'));
  writeFileSync(join(dir, '.env'), `VIBE_CLIENT_ID=${KEY.clientId}\nVIBE_HMAC_KEY=${TEST_SECRET}\n`);
  try {
    loadDotEnv(dir);
    const src = describeHealthSource({});
    assert.equal(src.mode, 'key-signing');
    assert.equal(src.keySource, '.env');
  } finally {
    delete process.env.VIBE_CLIENT_ID; delete process.env.VIBE_HMAC_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});
test('describeHealthSource: names the host source - flag, VSQL_HOST env, or a named saved profile', () => {
  assert.equal(describeHealthSource({ host: 'https://x.test' }).hostSource, '--host');
  process.env.VSQL_HOST = 'https://y.test';
  try {
    assert.equal(describeHealthSource({}).hostSource, 'VSQL_HOST (env)');
  } finally {
    delete process.env.VSQL_HOST;
  }
});

// ── the CLI itself, spawned: exit codes and config show (rigpert 63609) ──────────────────────────────────────────────
function cli(args, extraEnv = {}, opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vsql-home-'));
  const env = { ...saved.env, HOME: home, USERPROFILE: home, ...extraEnv };
  for (const k of ['VIBE_CLIENT_ID', 'VIBE_HMAC_KEY', 'VSQL_DEBUG']) if (!(k in extraEnv)) delete env[k];
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/vsql.js', import.meta.url)), ...args], { env, encoding: 'utf8', cwd: opts.cwd });
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

// ── PAY-1975 CLI layer: --data validation and delete's non-TTY refusal, no network involved ─────────────────────────
test('cli: update/replace refuse invalid --data locally, before any request would be made', () => {
  for (const cmd of ['update', 'replace']) {
    const r = cli([cmd, 'c', 't', '41', '--data', 'not json']);
    assert.notEqual(r.status, 0, `${cmd} with bad JSON exits non-zero`);
    assert.match(r.stderr, /INVALID_JSON/, `${cmd}: ${r.stderr}`);
  }
  const arr = cli(['update', 'c', 't', '41', '--data', '[1,2,3]']);
  assert.notEqual(arr.status, 0);
  assert.match(arr.stderr, /INVALID_JSON.*JSON object/);
});
test('cli: update/replace/delete require collection, table AND id (missing id is not silently treated as the table)', () => {
  const r = cli(['update', 'c', 't', '--data', '{}']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MISSING_ARGS/);
});
test('cli: delete without --yes, run non-interactively (no TTY), refuses rather than deleting or hanging on an unanswerable prompt', () => {
  const r = cli(['delete', 'c', 't', '41']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /CONFIRMATION_REQUIRED/);
  assert.match(r.stderr, /--yes/);
  // the alias behaves identically
  const aliased = cli(['data', 'delete', 'c', 't', '41']);
  assert.notEqual(aliased.status, 0);
  assert.match(aliased.stderr, /CONFIRMATION_REQUIRED/);
});
test('cli: `data update|replace|delete` are aliases - same validation as the bare commands', () => {
  const badJson = cli(['data', 'update', 'c', 't', '41', '--data', 'nope']);
  assert.notEqual(badJson.status, 0);
  assert.match(badJson.stderr, /INVALID_JSON/);
  const unknownSub = cli(['data', 'wat', 'c', 't', '41']);
  assert.notEqual(unknownSub.status, 0);
  assert.match(unknownSub.stderr, /UNKNOWN_COMMAND.*data wat/);
  const noSub = cli(['data']);
  assert.notEqual(noSub.status, 0);
  assert.match(noSub.stderr, /UNKNOWN_COMMAND/);
});

// ── PAY-1975 v1.3.2 CLI-level: key-mode query refusal, and .env picked up from cwd ───────────────────────────────────
test('cli: `query` with a KeelBase secret refuses LOCALLY with the sign-in hint - nothing is sent', () => {
  const r = cli(['query', 'select 1'], { VIBE_CLIENT_ID: 'vibe_25c8bbf4cd37c521', VIBE_HMAC_KEY: TEST_SECRET, VSQL_IDP_URL: 'https://idp.test' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /NOT_WITH_KEELBASE_SECRET/);
  assert.match(r.stderr, /vsql login/);
  assert.doesNotMatch(r.stderr, /RAW_SQL_PLATFORM_ADMIN_ONLY/, 'refused before any request - never the server error');
});
test('cli: a .env file in the working directory is picked up - config show reports key-signing from a value ONLY in .env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsql-cwd-'));
  try {
    writeFileSync(join(dir, '.env'), 'VIBE_CLIENT_ID=vibe_25c8bbf4cd37c521\nVIBE_HMAC_KEY=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=\n');
    // config show reads the key vars directly from process.env, which loadDotEnv() populates before
    // any command runs - so a value that ONLY exists in .env (never passed via extraEnv) still shows.
    const r = cli(['config', 'show'], {}, { cwd: dir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /key-signing/, `.env was not picked up: ${r.stdout} / ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('cli: a real env var still wins over a conflicting .env value in the same directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsql-cwd-'));
  try {
    writeFileSync(join(dir, '.env'), 'VSQL_HOST=http://127.0.0.1:2\n');
    const r = cli(['health'], { VSQL_HOST: 'http://127.0.0.1:1' }, { cwd: dir });
    assert.match(r.stderr, /127\.0\.0\.1:1/, `real env var should have won: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /127\.0\.0\.1:2/, 'the .env value must not have been used');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('cli: `health` names its mode/host/key-source line to stderr before making the request', () => {
  const r = cli(['health'], { VSQL_HOST: 'http://127.0.0.1:1' });
  assert.match(r.stderr, /mode: anonymous \(host from VSQL_HOST \(env\)\)/, r.stderr);
});

// ── PAY-1978 CLI-level: `tables --schema` refused locally, before any auth/network attempt ──────────────────────────
test('cli: `tables --schema` is refused locally (the information_schema framing is gone) - no auth/network is even attempted', () => {
  const r = cli(['tables', '--schema', 'public']); // no VIBE_CLIENT_ID/HMAC_KEY, no profile - would otherwise fail on auth first
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SCHEMA_FLAG_REMOVED/);
  assert.match(r.stderr, /vsql schemas/);
  assert.doesNotMatch(r.stderr, /NO_SESSION|NO_HOST/, 'refused before reaching auth resolution');
});
