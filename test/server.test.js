'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { encodeSecret, totp, readAuth, writeAuth } = require('../auth');

const root = path.join(__dirname, '..');
const token = 'example-test-password-only';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeStubs(bin) {
  if (process.platform === 'win32') {
    const source = path.join(bin, 'stub.cs');
    fs.writeFileSync(source, `
using System;
using System.IO;
using System.Diagnostics;
class Stub {
  static int Main(string[] a) {
    string name = Path.GetFileNameWithoutExtension(Process.GetCurrentProcess().MainModule.FileName).ToLowerInvariant();
    string dir = Environment.GetEnvironmentVariable("FAKE_DIR");
    if (name == "git") {
      if (a[0] == "clone") {
        if (File.Exists(Path.Combine(dir, "fail-clone"))) return 1;
        string dest = a[a.Length - 1];
        Directory.CreateDirectory(Path.Combine(dest, ".git"));
        File.Copy(Path.Combine(dir, "remote"), Path.Combine(dest, ".head"), true);
        string header = Environment.GetEnvironmentVariable("GIT_CONFIG_VALUE_0");
        if (header != null) { Console.WriteLine(header); Console.WriteLine(Environment.GetEnvironmentVariable("GIT_CONFIG_KEY_0")); }
      } else if (a[0] == "pull") File.Copy(Path.Combine(dir, "remote"), ".head", true);
      else if (a[0] == "fetch") File.Copy(Path.Combine(dir, "remote"), ".fetch", true);
      else if (a[0] == "merge-base") { if (File.ReadAllText(".fetch") == "rewound-commit") return 1; }
      else if (a[0] == "rev-parse") Console.Write(File.ReadAllText(a[1] == "HEAD" ? ".head" : ".fetch"));
      else if (a[0] == "ls-files") { if (File.Exists(Path.Combine(dir, "tracked-env"))) Console.WriteLine(".env"); }
      else return 1;
    } else if (name == "docker") {
      if (a.Length > 4 && a[0] == "compose" && a[1] == "ps" && a[2] == "-a" && a[3] == "--format") {
        string file = Path.Combine(dir, "containers.json");
        Console.WriteLine(File.Exists(file) ? File.ReadAllText(file) : "[{\\"ID\\":\\"aaaaaaaaaaaa\\",\\"Name\\":\\"app\\",\\"Service\\":\\"web\\",\\"State\\":\\"running\\",\\"Status\\":\\"Up\\"}]");
      }
      else if (a[0] == "inspect") Console.WriteLine("[{\\"Name\\":\\"app\\",\\"HostConfig\\":{\\"RestartPolicy\\":{\\"Name\\":\\"always\\"}},\\"Mounts\\":[],\\"NetworkSettings\\":{}}]");
      else if (a[0] == "logs") Console.WriteLine("container output");
      else if (a[0] == "top") Console.WriteLine("PID COMMAND\\n1 app");
      else if (a[0] == "stop" || a[0] == "kill" || a[0] == "start" || a[0] == "restart" || a[0] == "pause" || a[0] == "unpause") {
        File.AppendAllText(Path.Combine(dir, "container-actions"), a[0] + " " + a[1] + "\\n");
        if (File.Exists(Path.Combine(dir, "fail-container"))) { Console.Error.WriteLine("action failed"); return 1; }
        Console.WriteLine(a[1]);
      }
      else {
      if (a.Length > 1 && a[1] == "down" && File.Exists(Path.Combine(dir, "fail-down"))) return 1;
      if (a.Length > 1 && a[1] == "up" && File.Exists(Path.Combine(dir, "fail-up"))) return 1;
      if (a.Length > 1 && a[1] == "up" && File.Exists(Path.Combine(dir, "expected-env")) &&
          (!File.Exists(".env") || File.ReadAllText(".env") != File.ReadAllText(Path.Combine(dir, "expected-env")))) return 1;
      if (a.Length > 3 && a[1] == "ps" && a[2] == "--format" && a[3] == "json") {
        string file = Path.Combine(dir, "ports.json"); if (File.Exists(file)) Console.Write(File.ReadAllText(file));
      }
      else if (a.Length > 2 && a[1] == "ps" && a[2] == "-q") Console.WriteLine("container1");
      else if (a[0] == "stats") Console.WriteLine("{\\"Name\\":\\"app\\",\\"CPUPerc\\":\\"3%\\",\\"MemUsage\\":\\"1MiB / 2MiB\\",\\"MemPerc\\":\\"50%\\",\\"NetIO\\":\\"1B / 2B\\",\\"BlockIO\\":\\"3B / 4B\\"}");
      else Console.WriteLine("docker " + String.Join(" ", a));
      }
    } else if (name == "sh") Console.WriteLine(a[a.Length - 1]);
    else if (name == "ssh-keygen") {
      string key = a[a.Length - 1]; File.WriteAllText(key, "private"); File.WriteAllText(key + ".pub", "ssh-ed25519 test-public-key");
    }
    return 0;
  }
}`);
    const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const built = spawnSync(compiler, ['/nologo', `/out:${path.join(bin, 'git.exe')}`, source], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr || built.stdout);
    for (const name of ['docker', 'sh', 'ssh-keygen']) fs.copyFileSync(path.join(bin, 'git.exe'), path.join(bin, `${name}.exe`));
    return;
  }
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case "$1" in
  clone) [ ! -f "$FAKE_DIR/fail-clone" ] || exit 1; for last do :; done; mkdir -p "$last/.git"; cp "$FAKE_DIR/remote" "$last/.head"; if [ -n "$GIT_CONFIG_VALUE_0" ]; then echo "$GIT_CONFIG_VALUE_0"; echo "$GIT_CONFIG_KEY_0"; fi;;
  pull) cp "$FAKE_DIR/remote" .head;;
  fetch) cp "$FAKE_DIR/remote" .fetch;;
  merge-base) [ "$(cat .fetch)" != "rewound-commit" ];;
  rev-parse) if [ "$2" = HEAD ]; then cat .head; else cat .fetch; fi;;
  ls-files) if [ -f "$FAKE_DIR/tracked-env" ]; then echo .env; fi;;
  *) exit 1;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
if [ "$1" = compose ] && [ "$2" = ps ] && [ "$3" = -a ]; then if [ -f "$FAKE_DIR/containers.json" ]; then cat "$FAKE_DIR/containers.json"; else echo '[{"ID":"aaaaaaaaaaaa","Name":"app","Service":"web","State":"running","Status":"Up"}]'; fi; exit 0; fi
if [ "$1" = inspect ]; then echo '[{"Name":"app","HostConfig":{"RestartPolicy":{"Name":"always"}},"Mounts":[],"NetworkSettings":{}}]'; exit 0; fi
if [ "$1" = logs ]; then echo 'container output'; exit 0; fi
if [ "$1" = top ]; then printf 'PID COMMAND\\n1 app\\n'; exit 0; fi
case "$1" in stop|kill|start|restart|pause|unpause) echo "$1 $2" >> "$FAKE_DIR/container-actions"; if [ -f "$FAKE_DIR/fail-container" ]; then echo 'action failed' >&2; exit 1; fi; echo "$2"; exit 0;; esac
if [ "$2" = down ] && [ -f "$FAKE_DIR/fail-down" ]; then exit 1; fi
if [ "$2" = up ] && [ -f "$FAKE_DIR/fail-up" ]; then exit 1; fi
if [ "$2" = up ] && [ -f "$FAKE_DIR/expected-env" ]; then cmp -s .env "$FAKE_DIR/expected-env" || exit 1; fi
if [ "$2" = ps ] && [ "$3" = --format ] && [ "$4" = json ]; then [ ! -f "$FAKE_DIR/ports.json" ] || cat "$FAKE_DIR/ports.json"
elif [ "$2" = ps ] && [ "$3" = -q ]; then echo container1
elif [ "$1" = stats ]; then echo '{"Name":"app","CPUPerc":"3%","MemUsage":"1MiB / 2MiB","MemPerc":"50%","NetIO":"1B / 2B","BlockIO":"3B / 4B"}'
else echo "docker $*"; fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh-keygen'), '#!/bin/sh\nfor last do :; done\necho private > "$last"\necho "ssh-ed25519 test-public-key" > "$last.pub"\n', { mode: 0o755 });
}

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
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const secret = encodeSecret(Buffer.alloc(20, 7));
  writeAuth(dataDir, { secret, generation: 'a'.repeat(32), lastCounter: -1 }, true);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const proc = path.join(dir, 'proc');
  fs.mkdirSync(proc);
  fs.writeFileSync(path.join(proc, 'stat'), 'cpu 100 0 100 800 0 0 0 0\n');
  fs.writeFileSync(path.join(proc, 'meminfo'), 'MemTotal: 1000 kB\nMemAvailable: 400 kB\n');
  fs.writeFileSync(path.join(dir, 'remote'), 'first-commit');
  makeStubs(bin);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  let output = '';
  let sessionToken = '';
  function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: root,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DEPLOY_TOKEN: token, DATA_DIR: path.join(dir, 'data'), HOST_PROC_DIR: proc, POLL_INTERVAL_SECONDS: '10', FAKE_DIR: dir, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
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
  async function request(url, method = 'GET', body, authenticated = true, actionCode = 'auto') {
    const protectedAction = (method === 'POST' && (/\/deploy$/.test(url) || /\/containers\/[a-f0-9]+\/(stop|kill|restart|pause)$/i.test(url))) ||
      (method === 'DELETE' && /^\/api\/repos\/[0-9a-f-]+$/i.test(url));
    if (protectedAction && authenticated) {
      if (actionCode === 'auto') {
        writeAuth(dataDir, { ...readAuth(dataDir), lastCounter: -1 });
        actionCode = totp(secret, Math.floor(Date.now() / 30000));
      }
      if (actionCode !== null) body = { ...body, authCode: actionCode };
    }
    return fetch(base + url, {
      method,
      headers: { ...(authenticated ? { Authorization: ['Bearer', sessionToken].join(' ') } : {}), 'Content-Type': 'application/json' },
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
  assert.equal((await fetch(`${base}/api/repos`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  const login = async code => fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, code }) });
  let code = totp(secret, Math.floor(Date.now() / 30000) - 1);
  let loginResponse = await login(code);
  assert.equal(loginResponse.status, 200);
  sessionToken = (await loginResponse.json()).session;
  assert.equal((await login(code)).status, 401);
  assert.equal((await login('000000')).status, 401);
  const icon = await fetch(`${base}/icon.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(await icon.text(), /<svg/);
  const malformedResponse = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    let response = '';
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
  assert.match(malformedResponse, /^HTTP\/1\.1 400/);
  assert.equal((await request('/api/repos', 'GET', undefined, false)).status, 401);
  assert.equal((await request('/api/repos', 'POST', { url: '******example.com/repo.git' })).status, 400);
  assert.equal((await request('/api/repos', 'POST', { url: 'https://example.com/repo.git', branch: '../bad' })).status, 400);
  const added = await request('/api/repos', 'POST', { url: 'https://example.com/repo.git', branch: 'main', script: 'echo custom-step' });
  assert.equal(added.status, 202);
  const { id } = await added.json();
  await waitFor(async () => (await current(id)).status === 'ready');
  const iconUrl = `/api/repos/${id}/icon`;
  assert.equal((await request(iconUrl, 'GET', undefined, false)).status, 401);
  assert.deepEqual(await (await request(iconUrl)).json(), { icon: null });
  const cloneIcon = path.join(dataDir, 'repos', id, 'icon.svg');
  fs.writeFileSync(cloneIcon, '<svg></svg>');
  assert.deepEqual(await (await request(iconUrl)).json(), { icon: `data:image/svg+xml;base64,${Buffer.from('<svg></svg>').toString('base64')}` });
  const pageUrl = `/api/repos/${id}/page`;
  assert.equal((await request(pageUrl, 'GET', undefined, false)).status, 401);
  assert.equal((await request(pageUrl)).status, 409);
  const envUrl = `/api/repos/${id}/env`;
  assert.equal((await request(envUrl, 'GET', undefined, false)).status, 401);
  assert.deepEqual(await (await request(envUrl)).json(), { exists: false, tracked: false, content: '' });
  assert.equal((await request(envUrl, 'PUT', { content: 'a'.repeat(65537) })).status, 400);
  assert.equal((await request(envUrl, 'PUT', { content: 'BAD=\0' })).status, 400);
  const envContent = 'DATABASE_PASSWORD=test-secret-123\nLABEL=héllo\n';
  fs.writeFileSync(path.join(dir, 'expected-env'), envContent);
  assert.equal((await request(envUrl, 'PUT', { content: envContent })).status, 200);
  const envPath = path.join(dir, 'data', 'repos', id, '.env');
  assert.equal(fs.readFileSync(envPath, 'utf8'), envContent);
  if (process.platform !== 'win32') assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  assert.deepEqual(await (await request(envUrl)).json(), { exists: true, tracked: false, content: envContent });
  fs.writeFileSync(path.join(dir, 'tracked-env'), '');
  assert.equal((await (await request(envUrl)).json()).tracked, true);
  assert.equal((await request(envUrl, 'PUT', { content: 'replacement' })).status, 409);
  assert.equal(fs.readFileSync(envPath, 'utf8'), envContent);
  fs.rmSync(path.join(dir, 'tracked-env'));
  fs.renameSync(envPath, `${envPath}.backup`);
  fs.mkdirSync(envPath);
  assert.equal((await request(envUrl)).status, 409);
  assert.equal((await request(envUrl, 'PUT', { content: 'replacement' })).status, 409);
  fs.rmdirSync(envPath);
  if (process.platform !== 'win32') {
    fs.symlinkSync(`${envPath}.backup`, envPath);
    assert.equal((await request(envUrl)).status, 409);
    assert.equal((await request(envUrl, 'PUT', { content: 'replacement' })).status, 409);
    fs.unlinkSync(envPath);
  }
  fs.renameSync(`${envPath}.backup`, envPath);
  assert.equal((await request(`/api/repos/${id}/deploy`, 'POST', undefined, true, null)).status, 403);
  assert.equal((await request(`/api/repos/${id}/deploy`, 'POST')).status, 202);
  let repo = await waitFor(async () => { const item = await current(id); return item.status === 'deployed' && item; });
  assert.equal(repo.commit, 'first-commit');
  assert.match(repo.log, /docker compose up -d --build/);
  assert.doesNotMatch(repo.log, /--force-recreate/);
  assert.match(repo.log, /docker compose ps/);
  assert.match(repo.log, /docker compose logs --tail=100/);
  assert.match(repo.log, /custom-step/);
  assert.doesNotMatch(JSON.stringify(repo), /test-secret-123/);
  assert.doesNotMatch(JSON.stringify(await (await request('/api/activity')).json()), /test-secret-123/);
  assert.ok(repo.lastPulled);
  const containersUrl = `/api/repos/${id}/containers`;
  assert.deepEqual(await (await request(containersUrl)).json(), [{ id: 'aaaaaaaaaaaa', name: 'app', service: 'web', state: 'running', status: 'Up' }]);
  assert.equal((await request(`${containersUrl}/bbbbbbbbbbbb/stop`, 'POST')).status, 404);
  assert.equal((await request(`${containersUrl}/aaaaaaaaaaaab/stop`, 'POST')).status, 404);
  assert.equal((await request(`${containersUrl}/aaaaaaaaaaaa/logs`, 'GET', undefined, false)).status, 401);
  assert.match((await (await request(`${containersUrl}/aaaaaaaaaaaa/logs`)).json()).output, /container output/);
  assert.match((await (await request(`${containersUrl}/aaaaaaaaaaaa/processes`)).json()).output, /PID COMMAND/);
  assert.equal((await (await request(`${containersUrl}/aaaaaaaaaaaa/inspect`)).json()).data.HostConfig.RestartPolicy.Name, 'always');
  assert.equal((await request(`${containersUrl}/aaaaaaaaaaaa/stop`, 'POST', undefined, true, null)).status, 403);
  assert.equal((await request(`${containersUrl}/aaaaaaaaaaaa/stop`, 'POST')).status, 200);
  assert.equal((await request(`${containersUrl}/aaaaaaaaaaaa/stop`, 'POST', undefined, true, totp(secret, readAuth(dataDir).lastCounter))).status, 403);
  assert.equal(fs.readFileSync(path.join(dir, 'container-actions'), 'utf8').trim(), 'stop aaaaaaaaaaaa');
  fs.unlinkSync(path.join(dir, 'container-actions'));
  for (const command of ['stop', 'start', 'kill', 'restart', 'pause', 'resume']) assert.equal((await request(`${containersUrl}/aaaaaaaaaaaa/${command}`, 'POST')).status, 200);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'container-actions'), 'utf8').trim().split(/\r?\n/), ['stop', 'start', 'kill', 'restart', 'pause', 'unpause'].map(command => `${command} aaaaaaaaaaaa`));
  assert.equal((await current(id)).watching, true);
  fs.writeFileSync(path.join(dir, 'containers.json'), '{"ID":"aaaaaaaaaaaa","Name":"app","State":"running"}\n{"ID":"bbbbbbbbbbbb","Name":"worker","State":"exited"}\n');
  assert.equal((await (await request(containersUrl)).json()).length, 2);
  fs.writeFileSync(path.join(dir, 'containers.json'), '[{"Name":"missing ID"}]');
  assert.equal((await request(containersUrl)).status, 500);
  fs.unlinkSync(path.join(dir, 'containers.json'));
  fs.writeFileSync(path.join(dir, 'fail-container'), '');
  const failedAction = await request(`${containersUrl}/aaaaaaaaaaaa/restart`, 'POST');
  assert.equal(failedAction.status, 500);
  assert.match((await failedAction.json()).error, /action failed/);
  fs.unlinkSync(path.join(dir, 'fail-container'));
  assert.equal((await request(containersUrl)).status, 200);
  fs.writeFileSync(path.join(dir, 'ports.json'), JSON.stringify([
    { Service: 'web', State: 'running', Publishers: [{ URL: '0.0.0.0', PublishedPort: 8080, Protocol: 'tcp' }, { URL: '::', PublishedPort: 8443, Protocol: 'tcp' }, { URL: '0.0.0.0', PublishedPort: 9000, Protocol: 'udp' }] },
    { Service: 'db', State: 'exited', Publishers: [{ URL: '0.0.0.0', PublishedPort: 5432, Protocol: 'tcp' }] }
  ]));
  assert.deepEqual(await (await request(pageUrl)).json(), { url: null, ports: [{ port: 8080, hostIp: '0.0.0.0', service: 'web' }, { port: 8443, hostIp: '::', service: 'web' }] });
  fs.writeFileSync(path.join(dir, 'ports.json'), '{"Service":"web","State":"running","Publishers":[{"URL":"0.0.0.0","PublishedPort":8081,"Protocol":"tcp"}]}\n{"Service":"job","State":"exited","Publishers":null}\n');
  assert.deepEqual(await (await request(pageUrl)).json(), { url: null, ports: [{ port: 8081, hostIp: '0.0.0.0', service: 'web' }] });
  fs.writeFileSync(path.join(dir, 'ports.json'), '');
  assert.deepEqual(await (await request(pageUrl)).json(), { url: null, ports: [] });
  fs.writeFileSync(path.join(dir, 'ports.json'), 'invalid json');
  assert.equal((await request(pageUrl)).status, 500);
  assert.equal((await request(envUrl, 'PUT', { content: 'DOMAIN="example.test"\nSECRET=do-not-return\n' })).status, 200);
  assert.deepEqual(await (await request(pageUrl)).json(), { url: 'https://example.test/', ports: [] });
  assert.equal((await request(envUrl, 'PUT', { content: 'DOMAIN=http://example.test:8080/path\n' })).status, 200);
  assert.equal((await (await request(pageUrl)).json()).url, 'http://example.test:8080/path');
  assert.equal((await request(envUrl, 'PUT', { content: 'DOMAIN=https://user:password@example.test\n' })).status, 200);
  assert.equal((await request(pageUrl)).status, 500);
  assert.equal((await request(envUrl, 'PUT', { content: 'DOMAIN=${HOST}\n' })).status, 200);
  assert.equal((await request(pageUrl)).status, 500);
  assert.equal((await request(envUrl, 'PUT', { content: envContent })).status, 200);
  assert.equal((await request(`/api/repos/${id}/deploy`, 'POST')).status, 202);
  repo = await waitFor(async () => { const item = await current(id); return item.status === 'deployed' && item.log.includes('--force-recreate') && item; });
  assert.match(repo.log, /docker compose up -d --build --force-recreate/);
  const metric = await (await request('/api/metrics')).json();
  assert.equal(metric.containers[0].name, 'app');
  assert.equal(metric.containers[0].cpu, '3%');
  assert.equal(metric.host.cpuPercent, null);
  assert.equal(metric.host.memoryUsed, 600 * 1024);
  assert.equal(metric.host.memoryTotal, 1000 * 1024);
  fs.writeFileSync(path.join(proc, 'stat'), 'cpu 160 0 120 820 0 0 0 0\n');
  assert.equal((await (await request('/api/metrics')).json()).host.cpuPercent, 80);
  assert.ok((await (await request('/api/activity')).json()).some(entry => entry.repoId === id));
  await stop();
  start();
  await waitFor(async () => (await fetch(base)).ok);
  assert.equal((await request('/api/repos')).status, 401);
  code = totp(secret, Math.floor(Date.now() / 30000) + 1);
  loginResponse = await login(code);
  assert.equal(loginResponse.status, 200);
  sessionToken = (await loginResponse.json()).session;
  repo = await waitFor(async () => { const item = await current(id); return item && item.status === 'deployed' && item; });
  assert.equal(repo.commit, 'first-commit');
  assert.equal((await (await request(envUrl)).json()).content, envContent);
  const updatedEnv = 'DATABASE_PASSWORD=updated-secret\n';
  assert.equal((await request(envUrl, 'PUT', { content: updatedEnv })).status, 200);
  fs.writeFileSync(path.join(dir, 'expected-env'), updatedEnv);
  fs.writeFileSync(path.join(dir, 'remote'), 'second-commit');
  repo = await waitFor(async () => { const item = await current(id); return item.commit === 'second-commit' && item.status === 'deployed' && item; }, 14000);
  assert.ok(repo.lastChecked);
  assert.equal((repo.log.match(/^\$ docker compose up -d --build --force-recreate$/gm) || []).length, 1);
  assert.equal((await request(`/api/repos/${id}`, 'PATCH', { watching: false, script: 'echo updated' })).status, 200);
  repo = await current(id);
  assert.equal(repo.watching, false);
  assert.equal(repo.script, 'echo updated');
  assert.equal((await request(`/api/repos/${id}`, 'PATCH', { watching: true })).status, 200);
  fs.writeFileSync(path.join(dir, 'remote'), 'rewound-commit');
  repo = await waitFor(async () => { const item = await current(id); return item.status === 'error' && item; }, 14000);
  assert.match(repo.message, /not a fast-forward/);
  assert.equal(repo.commit, 'second-commit');
  fs.writeFileSync(path.join(dir, 'fail-down'), '');
  assert.equal((await request(`/api/repos/${id}`, 'DELETE', { containers: true, images: true }, true, null)).status, 403);
  assert.ok(await current(id));
  assert.equal((await request(`/api/repos/${id}`, 'DELETE', { containers: true, images: true })).status, 500);
  assert.ok(await current(id));
  assert.match((await current(id)).message, /Removal failed/);
  fs.rmSync(path.join(dir, 'fail-down'));
  assert.equal((await request(`/api/repos/${id}`, 'DELETE', { containers: true, images: true })).status, 200);
  assert.equal(fs.existsSync(envPath), false);
  fs.rmSync(path.join(dir, 'expected-env'));
  assert.ok((await (await request('/api/activity')).json()).some(entry => /docker compose down --rmi local/.test(entry.text)));

  fs.writeFileSync(path.join(dir, 'fail-clone'), '');
  const privateToken = 'test-secret-token';
  const privateResponse = await request('/api/repos', 'POST', { url: 'https://example.com/private.git', auth: { type: 'token', username: 'testuser', token: privateToken } });
  const privateRepo = await privateResponse.json();
  await waitFor(async () => (await current(privateRepo.id)).cloneFailed);
  assert.equal((await request(`/api/repos/${privateRepo.id}`, 'PATCH', { auth: { type: 'token', username: 'testuser', token: privateToken } })).status, 200);
  fs.rmSync(path.join(dir, 'fail-clone'));
  assert.equal((await request(`/api/repos/${privateRepo.id}/clone`, 'POST')).status, 202);
  const cloned = await waitFor(async () => { const item = await current(privateRepo.id); return item.status === 'ready' && !item.cloneFailed && item; });
  assert.doesNotMatch(JSON.stringify(cloned), /test-secret-token|dGVzdHVzZXI6dGVzdC1zZWNyZXQtdG9rZW4=/);
  assert.match(cloned.log, /\[REDACTED\]/);
  assert.match(cloned.log, /http\.https:\/\/example\.com\/\.extraheader/);
  assert.equal((await request(`/api/repos/${privateRepo.id}`, 'DELETE')).status, 200);
  assert.equal(fs.existsSync(path.join(dir, 'data', 'credentials', `${privateRepo.id}.json`)), false);

  const sshResponse = await request('/api/repos', 'POST', { url: 'ssh://git@example.com/private.git', auth: { type: 'ssh' } });
  const sshRepo = await sshResponse.json();
  assert.equal(sshRepo.status, 'awaiting-key');
  assert.match(sshRepo.publicKey, /^ssh-ed25519/);
  assert.equal((await request(`/api/repos/${sshRepo.id}/clone`, 'POST')).status, 202);
  await waitFor(async () => (await current(sshRepo.id)).status === 'ready');
  fs.writeFileSync(path.join(dir, 'fail-up'), '');
  assert.equal((await request(`/api/repos/${sshRepo.id}/deploy`, 'POST')).status, 202);
  await waitFor(async () => (await current(sshRepo.id)).status === 'error');
  assert.ok((await (await request('/api/metrics')).json()).containers.some(item => item.repoId === sshRepo.id));
  fs.rmSync(path.join(dir, 'fail-up'));
  assert.equal((await request(`/api/repos/${sshRepo.id}`, 'DELETE')).status, 200);
  assert.equal(fs.existsSync(path.join(dir, 'data', 'credentials', `${sshRepo.id}.key`)), false);
  assert.equal((await request('/api/repos')).status, 200);
  assert.equal((await (await request('/api/repos')).json()).length, 0);
  assert.equal((await request('/api/logout', 'POST')).status, 200);
  assert.equal((await request('/api/repos')).status, 401);
});
