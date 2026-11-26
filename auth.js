'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encodeSecret(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeSecret(secret) {
  if (typeof secret !== 'string' || !/^[A-Z2-7]{32}$/.test(secret)) throw new Error('Invalid authenticator configuration');
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(output);
}

function totp(secret, counter) {
  const input = Buffer.alloc(8);
  input.writeBigUInt64BE(BigInt(counter));
  const hash = crypto.createHmac('sha1', decodeSecret(secret)).update(input).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function verifyCode(secret, code, lastCounter = -1, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const counter = Math.floor(now / 30000);
  for (const candidate of [counter - 1, counter, counter + 1]) {
    if (candidate < 0 || candidate <= lastCounter) continue;
    if (crypto.timingSafeEqual(Buffer.from(totp(secret, candidate)), Buffer.from(code))) return candidate;
  }
  return null;
}

function readAuth(root) {
  const file = path.join(root, 'auth.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  decodeSecret(data.secret);
  if (typeof data.generation !== 'string' || !/^[0-9a-f]{32}$/.test(data.generation) ||
      !Number.isSafeInteger(data.lastCounter) || data.lastCounter < -1) throw new Error('Invalid authenticator configuration');
  return data;
}

function writeAuth(root, data, create = false) {
  const file = path.join(root, 'auth.json');
  if (create) {
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    return;
  }
  const temporary = path.join(root, `.auth-${crypto.randomBytes(16).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { encodeSecret, totp, verifyCode, readAuth, writeAuth };
