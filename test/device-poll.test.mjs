// PAY-1977: the device-code poll must name the client in the BODY (RFC 8628) as well as the X-Client-Id header.
// A deployed IdP whose poll DTO treats ClientId as required answered 400 to {device_code} alone, and the CLI reported
// "Unknown error: unknown" - so `vsql login` could never complete against dev-93.
// Reads dist (what ships): `npm test` builds first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { devicePollBody } from '../dist/config.js';

test('PAY-1977: the poll body carries device_code AND client_id', () => {
  assert.deepEqual(JSON.parse(devicePollBody('dc-123', 'vibe_abc12345')), { device_code: 'dc-123', client_id: 'vibe_abc12345' });
});

test('PAY-1977: the body does not invent other fields', () => {
  assert.deepEqual(Object.keys(JSON.parse(devicePollBody('d', 'c'))).sort(), ['client_id', 'device_code']);
});

test('PAY-1977: pollDeviceAuth builds its body through devicePollBody and still sends X-Client-Id', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const fn = src.slice(src.indexOf('async function pollDeviceAuth'), src.indexOf('async function pollDeviceAuth') + 900);
  assert.match(fn, /const body = devicePollBody\(deviceCode, clientId\(\)\);/, 'poll body must come from devicePollBody');
  assert.match(fn, /'X-Client-Id': clientId\(\)/, 'the header stays for older servers');
});
