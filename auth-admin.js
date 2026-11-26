'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { encodeSecret, verifyCode, readAuth, writeAuth } = require('./auth');
const { provisioningUri, terminalQr } = require('./enrollment');

async function main() {
  const action = process.argv[2];
  if (!['setup', 'reset'].includes(action)) throw new Error('Usage: node auth-admin.js setup|reset');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Authenticator setup requires an interactive terminal');
  const root = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const existing = readAuth(root);
  if (action === 'setup' && existing) throw new Error('Authenticator already configured. Use reset to replace it.');
  if (action === 'reset' && !existing) throw new Error('Authenticator is not configured. Use setup instead.');
  const secret = encodeSecret(crypto.randomBytes(20));
  const uri = provisioningUri(secret);
  console.log('Scan this QR code with your authenticator app:');
  console.log(terminalQr(uri));
  console.log('Or add this key manually as a time-based, 6-digit SHA1 code:');
  console.log(secret);
  console.log(`Provisioning URI: ${uri}`);
  console.log('Keep this key private. Verify it below before the configuration is saved.');
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const code = (await prompt.question('Authenticator code: ')).trim();
    const counter = verifyCode(secret, code);
    if (counter === null) throw new Error('Invalid authenticator code. No changes were made.');
    writeAuth(root, { secret, generation: crypto.randomBytes(16).toString('hex'), lastCounter: counter }, action === 'setup');
    console.log('Authenticator configured. Wait for the next code before signing in. Restart Git Deploy to invalidate existing sessions.');
  } finally {
    prompt.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
