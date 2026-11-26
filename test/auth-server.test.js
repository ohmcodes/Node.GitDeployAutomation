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

test('login switches from token to authenticator and protects sensitive actions', { timeout: 15000 }, async t => {
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
  fs.mkdirSync(path.join(dir, 'repos', repoId, '.git'), { recursive: true });
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
  const mode = async () => (await (await fetch(`${url}/api/auth/mode`)).json()).method;
  const request = session => fetch(`${url}/api/repos`, { headers: { Authorization: `Bearer ${session}` } });
  const remove = (session, authCode) => fetch(`${url}/api/repos/${repoId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ authCode })
  });
  await start();
  const code = totp(secret, Math.floor(Date.now() / 30000));
  assert.equal(await mode(), 'token');
  assert.equal((await post({ token: 'wrong-token' })).status, 401);
  const tokenLogin = await post({ token: 'test-deployment-token' });
  assert.equal(tokenLogin.status, 200);
  const tokenSession = (await tokenLogin.json()).session;
  assert.equal((await request(tokenSession)).status, 200);
  const blocked = await remove(tokenSession, code);
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /Set up an authenticator/);
  const deploy = await fetch(`${url}/api/repos/${repoId}/deploy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenSession}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ authCode: code })
  });
  assert.equal(deploy.status, 403);
  assert.match((await deploy.json()).error, /Set up an authenticator/);
  writeAuth(dir, state, true);
  assert.equal(await mode(), 'authenticator');
  assert.equal((await request(tokenSession)).status, 401);
  for (let count = 0; count < 5; count++) assert.equal((await post({ token: 'test-deployment-token' })).status, 401);
  assert.equal((await post({ code })).status, 429);
  await stop();
  await start();
  const login = await post({ code });
  assert.equal(login.status, 200);
  const session = (await login.json()).session;
  assert.equal((await post({ token: 'test-deployment-token', code })).status, 401);
  assert.equal((await request(session)).status, 200);
  await stop();
  await start();
  assert.equal((await request(session)).status, 401);
  assert.equal((await post({ token: 'test-deployment-token', code })).status, 401);
  const nextCode = totp(secret, Math.floor(Date.now() / 30000) + 1);
  const secondLogin = await post({ code: nextCode });
  assert.equal(secondLogin.status, 200);
  const secondSession = (await secondLogin.json()).session;
  assert.equal((await remove('invalid-session', 'bad')).status, 401);
  for (let count = 0; count < 5; count++) assert.equal((await remove(secondSession, 'bad')).status, 403);
  assert.equal((await remove(secondSession, nextCode)).status, 429);
  assert.equal((await (await fetch(`${url}/api/repos`, { headers: { Authorization: `Bearer ${secondSession}` } })).json()).length, 1);
  writeAuth(dir, { ...state, generation: 'c'.repeat(32) });
  assert.equal((await fetch(`${url}/api/repos`, { headers: { Authorization: `Bearer ${secondSession}` } })).status, 401);
  await stop();
  await start();
  assert.equal((await request(session)).status, 401);
});
