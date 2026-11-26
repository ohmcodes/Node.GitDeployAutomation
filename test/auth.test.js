'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeSecret, totp, verifyCode, readAuth, writeAuth } = require('../auth');
const { provisioningUri, terminalQr } = require('../enrollment');
const jsQR = require('jsqr');

test('TOTP validates RFC 6238 SHA1 codes and rejects replay', () => {
  const secret = encodeSecret(Buffer.from('12345678901234567890'));
  assert.equal(totp(secret, 1), '287082');
  assert.equal(verifyCode(secret, '287082', -1, 59000), 1);
  assert.equal(verifyCode(secret, '287082', 1, 59000), null);
  assert.equal(verifyCode(secret, '287082', -1, 120000), null);
  assert.equal(verifyCode(secret, 'bad', -1, 59000), null);
});

test('terminal QR code decodes to the exact authenticator provisioning URI', () => {
  const secret = encodeSecret(Buffer.from('12345678901234567890'));
  const uri = provisioningUri(secret);
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'otpauth:');
  assert.equal(parsed.searchParams.get('secret'), secret);
  assert.equal(parsed.searchParams.get('issuer'), 'Git Deploy');
  assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.equal(parsed.searchParams.get('period'), '30');
  const rows = terminalQr(uri).split('\n').map(line => Array.from(line.matchAll(/\x1b\[(40|47)m  \x1b\[0m/g), match => match[1] === '40'));
  assert.ok(rows.length > 8);
  assert.ok(rows.every(row => row.length === rows.length));
  assert.ok(rows.slice(0, 4).every(row => row.every(cell => !cell)));
  assert.ok(rows.every(row => row.slice(0, 4).every(cell => !cell)));
  const scale = 4;
  const width = rows.length * scale;
  const pixels = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const color = rows[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255;
      const index = (y * width + x) * 4;
      pixels[index] = color;
      pixels[index + 1] = color;
      pixels[index + 2] = color;
      pixels[index + 3] = 255;
    }
  }
  const decoded = jsQR(pixels, width, width);
  assert.ok(decoded, 'QR code must be readable');
  assert.equal(decoded.data, uri);
});

test('auth configuration is private, persisted, and fail-closed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-deploy-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readAuth(dir), null);
  const state = { secret: encodeSecret(Buffer.alloc(20, 3)), generation: 'a'.repeat(32), lastCounter: -1 };
  writeAuth(dir, state, true);
  assert.deepEqual(readAuth(dir), state);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'auth.json')).mode & 0o777, 0o600);
  assert.throws(() => writeAuth(dir, state, true), /EEXIST/);
  writeAuth(dir, { ...state, lastCounter: 42 });
  assert.equal(readAuth(dir).lastCounter, 42);
  fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
  assert.throws(() => readAuth(dir), /Invalid authenticator configuration/);
});
