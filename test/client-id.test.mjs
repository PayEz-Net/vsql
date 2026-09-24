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
  assert.deepEqual(r, { clientId: 'acme_dev', deprecated: false, conflict: false, missing: false, keelbaseClientIdMistake: false });
});

test('PAY-1814: VSQL_CLIENT_ID only -> used AS DEPRECATED', () => {
  const r = resolveClientId({ VSQL_CLIENT_ID: 'acme_dev' });
  assert.deepEqual(r, { clientId: 'acme_dev', deprecated: true, conflict: false, missing: false, keelbaseClientIdMistake: false });
});

test('PAY-1814: both set to the SAME value -> used, not a conflict, not deprecated', () => {
  const r = resolveClientId({ KEELBASE_CLIENT_ID: 'acme_dev', VSQL_CLIENT_ID: 'acme_dev' });
  assert.deepEqual(r, { clientId: 'acme_dev', deprecated: false, conflict: false, missing: false, keelbaseClientIdMistake: false });
});

test('PAY-1814: both set to DIFFERENT values -> CONFLICT (refuse, never guess)', () => {
  const r = resolveClientId({ KEELBASE_CLIENT_ID: 'acme_dev', VSQL_CLIENT_ID: 'other_dev' });
  assert.strictEqual(r.conflict, true);
  assert.strictEqual(r.clientId, undefined, 'there is no single value to return');
});

test('PAY-1814: neither set -> missing (fail loud, as before)', () => {
  const r = resolveClientId({});
  assert.deepEqual(r, { deprecated: false, conflict: false, missing: true, keelbaseClientIdMistake: false });
  // Blank/whitespace counts as unset - an empty export must not be treated as a value.
  assert.strictEqual(resolveClientId({ KEELBASE_CLIENT_ID: '   ' }).missing, true);
});

// ── NightHawk 64681 SHOULD: a `vibe_` KeelBase CLIENT id in KEELBASE_CLIENT_ID is REFUSED ──
test('PAY-1814 SHOULD: a vibe_ KeelBase client id in KEELBASE_CLIENT_ID is the WRONG value (refuse)', () => {
  const r = resolveClientId({ KEELBASE_CLIENT_ID: 'vibe_25c8bbf4cd37c521' });
  assert.strictEqual(r.keelbaseClientIdMistake, true, 'a vibe_ value is flagged');
  assert.strictEqual(r.clientId, undefined, 'and is not returned as a usable client id');
  // The SAME guard applies when the mistake arrives via the legacy name.
  assert.strictEqual(resolveClientId({ VSQL_CLIENT_ID: 'vibe_25c8bbf4cd37c521' }).keelbaseClientIdMistake, true);
  // A Tenant that merely CONTAINS 'vibe' is fine - the guard is the exact vibe_ + hex shape.
  assert.strictEqual(resolveClientId({ KEELBASE_CLIENT_ID: 'vibeforge_team' }).keelbaseClientIdMistake, false);
  // An email-shaped Tenant (the WO #256 form) is fine.
  assert.strictEqual(resolveClientId({ KEELBASE_CLIENT_ID: 'dev@example.test' }).keelbaseClientIdMistake, false);
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

test('PAY-1814 clientId(): a vibe_ value -> fatal CLIENT_ID_IS_KEELBASE_CLIENT_ID (the SHOULD guard)', () => {
  process.env.KEELBASE_CLIENT_ID = 'vibe_25c8bbf4cd37c521';
  assert.throws(() => clientId(), (e) => e instanceof Exit && e.code === 1);
  assert.match(stderr, /CLIENT_ID_IS_KEELBASE_CLIENT_ID/);
  assert.match(stderr, /Tenant/, 'the hint points at the Tenant, not the vibe_ id');
});

// PAY-1814 provenance: the CLI version MUST equal package.json version
// The 1.4.0 pack shipped a hardcoded VERSION='1.3.0' while package.json said 1.4.0, so the one thing a
// tester can ask the binary answered wrong. The CLI now READS package.json; this pins the identity so a
// future hardcode (or a missed bump) goes RED.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

test('PAY-1814: vsql version reports the package.json version (no hardcode can drift)', () => {
  const bin = fileURLToPath(new URL('../bin/vsql.js', import.meta.url));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const r = spawnSync(process.execPath, [bin, 'version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('v' + pkg.version), 'vsql version must be ' + pkg.version + ', got: ' + r.stdout);
});