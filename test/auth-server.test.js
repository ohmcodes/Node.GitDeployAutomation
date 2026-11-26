'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { encodeSecret, totp, writeAuth } = require('../auth');

test('login fails closed, rate limits, and invalidates sessions on reset', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-deploy-login-'));
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const secret = encodeSecret(Buffer.alloc(20, 9));
  const state = { secret, generation: 'b'.repeat(32), lastCounter: -1 };
  const repoId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify([{ id: repoId, url: 'https://example.com/repo.git', watching: false, status: 'ready' }]));
  let child;
  async function stop() {
    if (child && child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  }
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DEPLOY_TOKEN: 'test-deployment-token', DATA_DIR: dir, POLL_INTERVAL_SECONDS: '10' },
      stdio: 'ignore'
    });
    for (let count = 0; count < 100; count++) {
      try { if ((await fetch(url)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('Server did not start');
  }
  const post = input => fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  await start();
  const code = totp(secret, Math.floor(Date.now() / 30000));
  assert.equal((await post({ token: 'test-deployment-token', code })).status, 503);
  writeAuth(dir, state, true);
  for (let count = 0; count < 4; count++) assert.equal((await post({ token: 'wrong-token', code })).status, 401);
  assert.equal((await post({ token: 'test-deployment-token', code })).status, 429);
  await stop();
  await start();
  const login = await post({ token: 'test-deployment-token', code });
  assert.equal(login.status, 200);
  const session = (await login.json()).session;
  assert.equal((await post({ token: 'test-deployment-token', code })).status, 401);
  const request = () => fetch(`${url}/api/repos`, { headers: { Authorization: `Bearer ${session}` } });
  assert.equal((await request()).status, 200);
  await stop();
  await start();
  assert.equal((await request()).status, 401);
  assert.equal((await post({ token: 'test-deployment-token', code })).status, 401);
  const nextCode = totp(secret, Math.floor(Date.now() / 30000) + 1);
  const secondLogin = await post({ token: 'test-deployment-token', code: nextCode });
  assert.equal(secondLogin.status, 200);
  const secondSession = (await secondLogin.json()).session;
  const remove = (session, authCode) => fetch(`${url}/api/repos/${repoId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ authCode })
  });
  assert.equal((await remove('invalid-session', 'bad')).status, 401);
  for (let count = 0; count < 5; count++) assert.equal((await remove(secondSession, 'bad')).status, 403);
  assert.equal((await remove(secondSession, nextCode)).status, 429);
  assert.equal((await (await fetch(`${url}/api/repos`, { headers: { Authorization: `Bearer ${secondSession}` } })).json()).length, 1);
  writeAuth(dir, { ...state, generation: 'c'.repeat(32) });
  assert.equal((await fetch(`${url}/api/repos`, { headers: { Authorization: `Bearer ${secondSession}` } })).status, 401);
  await stop();
  await start();
  assert.equal((await request()).status, 401);
});
