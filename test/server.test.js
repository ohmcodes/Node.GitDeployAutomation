'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const token = 'example-test-password-only';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('authenticated clone, deployment, persistence, watcher and settings', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-deploy-test-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'remote'), 'first-commit');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case "$1" in
  clone) for last do :; done; mkdir -p "$last/.git"; cp "$FAKE_DIR/remote" "$last/.head";;
  pull) cp "$FAKE_DIR/remote" .head;;
  fetch) cp "$FAKE_DIR/remote" .fetch;;
  merge-base) [ "$(cat .fetch)" != "rewound-commit" ];;
  rev-parse) if [ "$2" = HEAD ]; then cat .head; else cat .fetch; fi;;
  *) exit 1;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\necho "docker $*"\n', { mode: 0o755 });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  let output = '';
  function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: root,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DEPLOY_TOKEN: token, DATA_DIR: path.join(dir, 'data'), POLL_INTERVAL_SECONDS: '10', FAKE_DIR: dir, PATH: `${bin}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
  }
  async function stop() {
    if (child && child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  }
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function request(url, method = 'GET', body, authenticated = true) {
    return fetch(base + url, {
      method,
      headers: { ...(authenticated ? { Authorization: ['Bearer', token].join(' ') } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }
  async function waitFor(fn, timeout = 5000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const result = await fn(); if (result) return result; } catch {}
      await delay(100);
    }
    assert.fail(`Timed out waiting for condition. Server output: ${output}`);
  }
  async function current(id) {
    const response = await request('/api/repos');
    return (await response.json()).find(repo => repo.id === id);
  }
  start();
  await waitFor(async () => (await fetch(base)).ok);
  assert.equal((await request('/api/repos', 'GET', undefined, false)).status, 401);
  assert.equal((await request('/api/repos', 'POST', { url: '******example.com/repo.git' })).status, 400);
  assert.equal((await request('/api/repos', 'POST', { url: 'https://example.com/repo.git', branch: '../bad' })).status, 400);
  const added = await request('/api/repos', 'POST', { url: 'https://example.com/repo.git', branch: 'main', script: 'echo custom-step' });
  assert.equal(added.status, 202);
  const { id } = await added.json();
  await waitFor(async () => (await current(id)).status === 'ready');
  assert.equal((await request(`/api/repos/${id}/deploy`, 'POST')).status, 202);
  let repo = await waitFor(async () => { const item = await current(id); return item.status === 'deployed' && item; });
  assert.equal(repo.commit, 'first-commit');
  assert.match(repo.log, /docker compose up -d --build/);
  assert.match(repo.log, /docker compose ps/);
  assert.match(repo.log, /docker compose logs --tail=100/);
  assert.match(repo.log, /custom-step/);
  await stop();
  start();
  repo = await waitFor(async () => { const item = await current(id); return item && item.status === 'deployed' && item; });
  assert.equal(repo.commit, 'first-commit');
  fs.writeFileSync(path.join(dir, 'remote'), 'second-commit');
  repo = await waitFor(async () => { const item = await current(id); return item.commit === 'second-commit' && item.status === 'deployed' && item; }, 14000);
  assert.ok(repo.lastChecked);
  assert.equal((await request(`/api/repos/${id}`, 'PATCH', { watching: false, script: 'echo updated' })).status, 200);
  repo = await current(id);
  assert.equal(repo.watching, false);
  assert.equal(repo.script, 'echo updated');
  assert.equal((await request(`/api/repos/${id}`, 'PATCH', { watching: true })).status, 200);
  fs.writeFileSync(path.join(dir, 'remote'), 'rewound-commit');
  repo = await waitFor(async () => { const item = await current(id); return item.status === 'error' && item; }, 14000);
  assert.match(repo.message, /not a fast-forward/);
  assert.equal(repo.commit, 'second-commit');
  assert.equal((await request(`/api/repos/${id}`, 'DELETE')).status, 200);
  assert.equal((await request('/api/repos')).status, 200);
  assert.equal((await (await request('/api/repos')).json()).length, 0);
});
