// PAY-1814: KEELBASE_CLIENT_ID is the client the CLI signs in on; VSQL_CLIENT_ID is a deprecated fallback.
//
// Jon (rigpert 64624/64638): the rename goes ahead. The canonical repo is github PayEz-Net/vsql (the ADO
// vsql-cli is a stale mirror). This repo fail-louds with NO default, so the fallback is load-bearing: a
// bare rename would break every existing .env at startup.
//
// The FIVE cases (BAPert 64626):
//   1. KEELBASE_CLIENT_ID only  -> used, no warning.
//   2. VSQL_CLIENT_ID only      -> used, ONE deprecation warning.
//   3. both, SAME value         -> used, no warning.
//   4. both, DIFFERENT value    -> REFUSE.
//   5. neither                  -> fail loud (NO_CLIENT_ID).
// Reads dist (what ships): `npm test` builds first.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientId } from '../dist/config.js';

// resolveClientId is PURE (takes the env), so the five cases are asserted directly, no process.env needed.
test('PAY-1814: KEELBASE_CLIENT_ID only -> used, no deprecation', () => {
  const r = resolveClientId({ KEELBASE_CLIENT_ID: 'acme_dev' });
  assert.deepEqual(r, { clientId: 'acme_dev', deprecated: false, conflict: false, missing: false });
});

test('PAY-1814: VSQL_CLIENT_ID only -> used AS DEPRECATED', () => {
  const r = resolveClientId({ VSQL_CLIENT_ID: 'acme_dev' });
  assert.deepEqual(r, { clientId: 'acme_dev', deprecated: true, conflict: false, missing: false });
});

test('PAY-1814: both set to the SAME value -> used, not a conflict, not deprecated', () => {
  const r = resolveClientId({ KEELBASE_CLIENT_ID: 'acme_dev', VSQL_CLIENT_ID: 'acme_dev' });
  assert.deepEqual(r, { clientId: 'acme_dev', deprecated: false, conflict: false, missing: false });
});

test('PAY-1814: both set to DIFFERENT values -> CONFLICT (refuse, never guess)', () => {
  const r = resolveClientId({ KEELBASE_CLIENT_ID: 'acme_dev', VSQL_CLIENT_ID: 'other_dev' });
  assert.strictEqual(r.conflict, true);
  assert.strictEqual(r.clientId, undefined, 'there is no single value to return');
});

test('PAY-1814: neither set -> missing (fail loud, as before)', () => {
  const r = resolveClientId({});
  assert.deepEqual(r, { deprecated: false, conflict: false, missing: true });
  // Blank/whitespace counts as unset - an empty export must not be treated as a value.
  assert.strictEqual(resolveClientId({ KEELBASE_CLIENT_ID: '   ' }).missing, true);
});

// ── the WARNING-ONCE and the exit codes, through the shipped clientId() ──
// clientId() is what login/refresh call (index.ts:97/102/...). Here it is driven directly with
// process.exit + process.stderr stubbed, exactly as client.test.mjs does, so the exit code and the
// warning count are pinned without a network call.
import { clientId } from '../dist/config.js';

class Exit extends Error { constructor(code) { super(`exit ${code}`); this.code = code; } }
let stderr, saved;

beforeEach(() => {
  stderr = '';
  saved = { exit: process.exit, write: process.stderr.write, env: { ...process.env } };
  process.exit = (code) => { throw new Exit(code); };
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  for (const k of ['KEELBASE_CLIENT_ID', 'VSQL_CLIENT_ID']) delete process.env[k];
});
afterEach(() => {
  process.exit = saved.exit; process.stderr.write = saved.write; process.env = saved.env;
});

test('PAY-1814 clientId(): KEELBASE_CLIENT_ID only -> the value, no deprecation warning', () => {
  process.env.KEELBASE_CLIENT_ID = 'acme_dev';
  assert.equal(clientId(), 'acme_dev');
  assert.equal(stderr, '', `no warning expected, got: ${stderr}`);
});

test('PAY-1814 clientId(): VSQL_CLIENT_ID only -> the value, ONE deprecation warning naming the rename', () => {
  process.env.VSQL_CLIENT_ID = 'acme_dev';
  assert.equal(clientId(), 'acme_dev');
  assert.equal((stderr.match(/VSQL_CLIENT_ID is deprecated/gi) ?? []).length, 1, `exactly one warning: ${stderr}`);
  assert.match(stderr, /KEELBASE_CLIENT_ID/, 'the warning names the new variable');
  // Calling again does NOT repeat the warning (once per process, however many callers).
  clientId();
  assert.equal((stderr.match(/VSQL_CLIENT_ID is deprecated/gi) ?? []).length, 1, 'still one warning after a second call');
});

test('PAY-1814 clientId(): both set, DIFFERENT -> fatal CLIENT_ID_CONFLICT (never guesses)', () => {
  process.env.KEELBASE_CLIENT_ID = 'acme_dev';
  process.env.VSQL_CLIENT_ID = 'other_dev';
  assert.throws(() => clientId(), (e) => e instanceof Exit && e.code === 1);
  assert.match(stderr, /CLIENT_ID_CONFLICT/);
  assert.match(stderr, /KEELBASE_CLIENT_ID/, 'the hint names the new variable to keep');
});

test('PAY-1814 clientId(): neither set -> fatal NO_CLIENT_ID (fails loud, as before)', () => {
  assert.throws(() => clientId(), (e) => e instanceof Exit && e.code === 1);
  assert.match(stderr, /NO_CLIENT_ID/);
  assert.match(stderr, /KEELBASE_CLIENT_ID/, 'the message names KEELBASE_CLIENT_ID, not the old name');
});
