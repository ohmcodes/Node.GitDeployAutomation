'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');

const root = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const reposDir = path.join(root, 'repos');
const stateFile = path.join(root, 'state.json');
const activityFile = path.join(root, 'activity.json');
const credentialsDir = path.join(root, 'credentials');
const token = process.env.DEPLOY_TOKEN || '';
const interval = Number(process.env.POLL_INTERVAL_SECONDS || 60);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

if (token.length < 16) throw new Error('DEPLOY_TOKEN must be at least 16 characters');
if (!Number.isInteger(interval) || interval < 10) throw new Error('POLL_INTERVAL_SECONDS must be an integer of at least 10');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
fs.mkdirSync(reposDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
let repos = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : [];
if (!Array.isArray(repos)) throw new Error('Invalid state file');
let activity = fs.existsSync(activityFile) ? JSON.parse(fs.readFileSync(activityFile, 'utf8')) : [];
if (!Array.isArray(activity)) throw new Error('Invalid activity file');
const active = new Set();

function save() {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(repos, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

for (const repo of repos) {
  if (['cloning', 'deploying', 'rebuilding', 'checking', 'removing'].includes(repo.status)) {
    if (repo.status === 'cloning') repo.cloneFailed = true;
    repo.status = 'error';
    repo.message = 'Operation interrupted by restart. Deploy manually to retry.';
  }
}
save();

function append(repo, text) {
  repo.log = ((repo.log || '') + text).slice(-40000);
  activity.push({ time: new Date().toISOString(), repoId: repo.id, url: repo.url, text: text.slice(-40000) });
  activity = activity.slice(-200);
  const tmp = `${activityFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(activity), { mode: 0o600 });
  fs.renameSync(tmp, activityFile);
  save();
}

function exec(program, args, options) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let escalated = false;
    let pending;
    const finish = (error, stdout, stderr) => {
      if (timedOut && !escalated) {
        pending = [error, stdout, stderr];
        return;
      }
      if (timedOut && !error) error = new Error('Command timed out');
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    };
    const child = execFile(program, args, { ...options, detached: process.platform !== 'win32' }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') terminate('SIGKILL');
      finish(error, stdout, stderr);
    });
    const terminate = signal => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else if (child.pid) process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') console.error(error);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      setTimeout(() => {
        terminate('SIGKILL');
        escalated = true;
        if (pending) finish(...pending);
      }, 1000).unref();
    }, 15 * 60 * 1000);
  });
}

function credentialsPath(repo) {
  return path.join(credentialsDir, `${repo.id}.json`);
}

function readCredentials(repo) {
  const file = credentialsPath(repo);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

async function run(repo, program, args, cwd) {
  append(repo, `\n$ ${program} ${args.join(' ')}\n`);
  const credentials = program === 'git' ? readCredentials(repo) : null;
  const secret = credentials && credentials.type === 'token' ? credentials.token : '';
  const redact = text => {
    if (!secret) return text;
    return text.split(secret).join('[REDACTED]').split(Buffer.from(`${credentials.username}:${secret}`).toString('base64')).join('[REDACTED]');
  };
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    delete env.DEPLOY_TOKEN;
    if (credentials && credentials.type === 'token') {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = `http.${new URL(repo.url).origin}/.extraheader`;
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`${credentials.username}:${secret}`).toString('base64')}`;
    } else if (credentials && credentials.type === 'ssh') {
      const key = path.join(credentialsDir, `${repo.id}.key`);
      env.GIT_SSH_COMMAND = `ssh -i '${key.replace(/'/g, "'\\''")}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes`;
    }
    const result = await exec(program, args, { cwd, maxBuffer: 2 * 1024 * 1024, env });
    append(repo, redact((result.stdout || '') + (result.stderr || '')));
    return result.stdout.trim();
  } catch (error) {
    append(repo, redact((error.stdout || '') + (error.stderr || '') + `\n${error.message}\n`));
    throw new Error(`${program} failed`);
  }
}

function location(repo) {
  return path.join(reposDir, repo.id);
}

async function exclusive(repo, status, work) {
  if (active.has(repo.id)) return false;
  active.add(repo.id);
  repo.status = status;
  repo.message = '';
  save();
  try {
    await work();
    repo.status = repo.lastDeployed ? 'deployed' : 'ready';
  } catch (error) {
    repo.status = 'error';
    repo.message = error.message;
  } finally {
    active.delete(repo.id);
    save();
  }
  return true;
}

async function clone(repo) {
  await exclusive(repo, 'cloning', async () => {
    await run(repo, 'git', ['clone', '--branch', repo.branch, '--single-branch', '--', repo.url, location(repo)], reposDir);
  });
  repo.cloneFailed = repo.status === 'error';
  save();
}

async function deployWork(repo, forceRecreate = false) {
  const cwd = location(repo);
  await run(repo, 'git', ['pull', '--ff-only', 'origin', repo.branch], cwd);
  repo.lastPulled = new Date().toISOString();
  repo.status = 'rebuilding';
  repo.composeAttempted = true;
  save();
  await run(repo, 'docker', ['compose', 'up', '-d', '--build', ...(forceRecreate ? ['--force-recreate'] : [])], cwd);
  repo.status = 'deploying';
  save();
  if (repo.script) await run(repo, 'sh', ['-c', repo.script], cwd);
  await run(repo, 'docker', ['compose', 'ps'], cwd);
  await run(repo, 'docker', ['compose', 'logs', '--tail=100'], cwd);
  repo.commit = await run(repo, 'git', ['rev-parse', 'HEAD'], cwd);
  repo.lastDeployed = new Date().toISOString();
}

function deploy(repo) {
  return exclusive(repo, 'deploying', () => deployWork(repo, !!repo.lastDeployed));
}

function check(repo) {
  return exclusive(repo, 'checking', async () => {
    const cwd = location(repo);
    await run(repo, 'git', ['fetch', 'origin', repo.branch], cwd);
    const remote = await run(repo, 'git', ['rev-parse', 'FETCH_HEAD'], cwd);
    if (remote !== repo.commit) {
      try {
        await run(repo, 'git', ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'], cwd);
      } catch {
        throw new Error('Remote branch is not a fast-forward; resolve it before deploying.');
      }
      repo.status = 'deploying';
      save();
      await deployWork(repo);
    }
    repo.lastChecked = new Date().toISOString();
  });
}

function validUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return ['https:', 'ssh:'].includes(url.protocol) && !!url.hostname &&
      !url.password && (url.protocol === 'ssh:' || !url.username) &&
      !url.search && !url.hash && url.pathname.length > 1;
  } catch {
    return false;
  }
}

function validBranch(value) {
  return typeof value === 'string' && value.length <= 200 &&
    /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) &&
    !value.includes('..') && !value.includes('//') &&
    !value.endsWith('.') && !value.endsWith('/') &&
    !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'));
}

function validTokenAuth(auth, url) {
  return auth && auth.type === 'token' && new URL(url).protocol === 'https:' &&
    typeof auth.username === 'string' && !!auth.username && auth.username.length <= 200 && !/[:\r\n]/.test(auth.username) &&
    typeof auth.token === 'string' && !!auth.token && auth.token.length <= 4096 && !/[\r\n]/.test(auth.token);
}

function pageDomain(repo) {
  const file = path.join(location(repo), '.env');
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) {
    throw new Error('The repository .env must be a regular file no larger than 64 KiB');
  }
  let value;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?DOMAIN\s*=\s*(.*)$/);
    if (!match) continue;
    const raw = match[1].trim();
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quoted = raw.match(/^(["'])(.*?)\1(?:\s+#.*)?\s*$/);
      if (!quoted) throw new Error('DOMAIN in .env has invalid quoting');
      value = quoted[2];
    } else {
      value = raw.replace(/\s+#.*$/, '').trim();
    }
  }
  if (!value) return null;
  if (value.includes('$') || value.includes('\\') || /[\s\x00-\x1f]/.test(value)) {
    throw new Error('DOMAIN must be a literal hostname or HTTP(S) URL without variables');
  }
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new Error('DOMAIN must be a valid hostname or HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('DOMAIN must be an HTTP(S) URL without credentials, query, or fragment');
  }
  return url.href;
}

async function publishedPorts(repo) {
  const env = { ...process.env };
  delete env.DEPLOY_TOKEN;
  const output = (await exec('docker', ['compose', 'ps', '--format', 'json'], {
    cwd: location(repo), env, maxBuffer: 2 * 1024 * 1024
  })).stdout.trim();
  if (!output) return [];
  let services;
  try {
    services = output.startsWith('[') ? JSON.parse(output) : output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    if (!Array.isArray(services)) throw new Error('Unexpected Compose output');
  } catch {
    throw new Error('Could not read published ports from Docker Compose');
  }
  const ports = [];
  for (const service of services) {
    if (service.State !== 'running' || !Array.isArray(service.Publishers)) continue;
    for (const publisher of service.Publishers) {
      const port = publisher.PublishedPort;
      if (publisher.Protocol !== 'tcp' || !Number.isInteger(port) || port < 1 || port > 65535) continue;
      const hostIp = typeof publisher.URL === 'string' ? publisher.URL : '';
      const name = typeof service.Service === 'string' ? service.Service : '';
      if (!ports.some(item => item.port === port && item.hostIp === hostIp && item.service === name)) ports.push({ port, hostIp, service: name });
    }
  }
  return ports;
}

let previousHostCpu;
let previousRuntimeCpu;
function hostMetrics() {
  const proc = process.env.HOST_PROC_DIR;
  if (!proc) return { error: 'Host metrics require HOST_PROC_DIR to point to the Docker host proc filesystem.' };
  try {
    const cpu = fs.readFileSync(path.join(proc, 'stat'), 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    if (cpu.length < 4 || cpu.some(value => !Number.isFinite(value))) throw new Error('Invalid host CPU data');
    const total = cpu.slice(0, 8).reduce((sum, value) => sum + value, 0);
    const idle = cpu[3] + (cpu[4] || 0);
    const deltaTotal = previousHostCpu ? total - previousHostCpu.total : 0;
    const cpuPercent = deltaTotal > 0 ? 100 * (1 - (idle - previousHostCpu.idle) / deltaTotal) : null;
    previousHostCpu = { total, idle };
    const memory = fs.readFileSync(path.join(proc, 'meminfo'), 'utf8');
    const totalMatch = memory.match(/^MemTotal:\s+(\d+)\s+kB/m);
    const availableMatch = memory.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!totalMatch || !availableMatch) throw new Error('Host memory information unavailable');
    return { cpuPercent, memoryTotal: Number(totalMatch[1]) * 1024, memoryUsed: (Number(totalMatch[1]) - Number(availableMatch[1])) * 1024 };
  } catch (error) {
    return { error: `Host metrics unavailable: ${error.message}` };
  }
}

async function metrics() {
  const usage = process.cpuUsage();
  const now = process.hrtime.bigint();
  const runtimeCpu = previousRuntimeCpu ? 100 * ((usage.user + usage.system) - previousRuntimeCpu.used) / (Number(now - previousRuntimeCpu.time) / 1000) : null;
  previousRuntimeCpu = { used: usage.user + usage.system, time: now };
  const result = {
    runtime: { cpuPercent: runtimeCpu, rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, uptime: process.uptime(), platform: os.platform() },
    host: hostMetrics(),
    containers: []
  };
  for (const repo of repos) {
    if ((!repo.lastDeployed && !repo.composeAttempted) || !fs.existsSync(path.join(location(repo), '.git'))) continue;
    try {
      const options = { cwd: location(repo), env: { ...process.env }, maxBuffer: 2 * 1024 * 1024 };
      delete options.env.DEPLOY_TOKEN;
      const ids = (await exec('docker', ['compose', 'ps', '-q'], options)).stdout.trim().split(/\s+/).filter(Boolean);
      if (!ids.length) continue;
      const output = (await exec('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids], options)).stdout.trim();
      for (const line of output.split('\n').filter(Boolean)) {
        const stat = JSON.parse(line);
        result.containers.push({ repoId: repo.id, name: stat.Name, cpu: stat.CPUPerc, memory: stat.MemUsage, memoryPercent: stat.MemPerc, network: stat.NetIO, block: stat.BlockIO });
      }
    } catch (error) {
      result.containers.push({ repoId: repo.id, error: `Container metrics unavailable: ${error.message}` });
    }
  }
  return result;
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function body(req, limit = 32768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid request');
  return value;
}

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};
const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return send(res, 400, { error: 'Invalid request URL' });
  }
  if (req.method === 'GET' && assets[pathname]) {
    const [file, type] = assets[pathname];
    res.writeHead(200, {
      'Content-Type': type, 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(path.join(__dirname, 'public', file)).pipe(res);
    return;
  }
  if (!pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
  const authorization = req.headers.authorization || '';
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expectedHash = crypto.createHash('sha256').update(token).digest();
  const suppliedHash = crypto.createHash('sha256').update(supplied).digest();
  if (!crypto.timingSafeEqual(expectedHash, suppliedHash)) return send(res, 401, { error: 'Unauthorized' });

  try {
    if (pathname === '/api/repos' && req.method === 'GET') return send(res, 200, repos);
    if (pathname === '/api/activity' && req.method === 'GET') return send(res, 200, activity);
    if (pathname === '/api/metrics' && req.method === 'GET') return send(res, 200, await metrics());
    if (pathname === '/api/repos' && req.method === 'POST') {
      const input = await body(req);
      const branch = input.branch || 'main';
      const script = input.script || '';
      const auth = input.auth || { type: 'none' };
      if (!validUrl(input.url) || !validBranch(branch) || typeof script !== 'string' || script.length > 10000) {
        return send(res, 400, { error: 'Invalid URL, branch, or script' });
      }
      if (!auth || !['none', 'token', 'ssh'].includes(auth.type) ||
          (auth.type === 'token' && !validTokenAuth(auth, input.url)) ||
          (auth.type === 'ssh' && new URL(input.url).protocol !== 'ssh:')) {
        return send(res, 400, { error: 'Invalid authentication settings for repository URL' });
      }
      const repo = { id: crypto.randomUUID(), url: input.url, branch, script, authType: auth.type, watching: true, status: 'ready', message: '', log: '', commit: null, lastDeployed: null, lastChecked: null };
      if (auth.type === 'token') {
        fs.writeFileSync(credentialsPath(repo), JSON.stringify({ type: 'token', username: auth.username, token: auth.token }), { mode: 0o600, flag: 'wx' });
      } else if (auth.type === 'ssh') {
        const key = path.join(credentialsDir, `${repo.id}.key`);
        try {
          await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { maxBuffer: 1024 * 1024 });
          repo.publicKey = fs.readFileSync(`${key}.pub`, 'utf8').trim();
          fs.writeFileSync(credentialsPath(repo), JSON.stringify({ type: 'ssh' }), { mode: 0o600, flag: 'wx' });
          repo.status = 'awaiting-key';
        } catch (error) {
          fs.rmSync(key, { force: true });
          fs.rmSync(`${key}.pub`, { force: true });
          throw error;
        }
      }
      repos.push(repo);
      save();
      append(repo, auth.type === 'ssh' ? 'Repository added; awaiting SSH key authorization.\n' : 'Repository added.\n');
      if (auth.type !== 'ssh') void clone(repo);
      return send(res, 202, repo);
    }
    const match = pathname.match(/^\/api\/repos\/([0-9a-f-]{36})(?:\/(deploy|clone|env|page))?$/);
    const repo = match && repos.find(item => item.id === match[1]);
    if (!repo) return send(res, 404, { error: 'Not found' });
    if (match[2] === 'page' && req.method === 'GET') {
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      if (!repo.lastDeployed) return send(res, 409, { error: 'Deploy the repository before opening its page' });
      active.add(repo.id);
      try {
        const domain = pageDomain(repo);
        if (domain) return send(res, 200, { url: domain, ports: [] });
        return send(res, 200, { url: null, ports: await publishedPorts(repo) });
      } catch (error) {
        console.error('Unable to determine project page:', error.message);
        return send(res, 500, { error: `Unable to determine project page: ${error.message}` });
      } finally {
        active.delete(repo.id);
      }
    }
    if (match[2] === 'env' && (req.method === 'GET' || req.method === 'PUT')) {
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      let input;
      if (req.method === 'PUT') {
        input = await body(req, 524288);
        if (!repos.includes(repo)) return send(res, 404, { error: 'Not found' });
        if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 65536 || input.content.includes('\0')) {
          return send(res, 400, { error: 'Environment file must be text no larger than 64 KiB' });
        }
      }
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      if (repo.cloneFailed || repo.status === 'awaiting-key' || !fs.existsSync(path.join(location(repo), '.git'))) {
        return send(res, 409, { error: 'Clone the repository successfully before editing its environment file' });
      }
      active.add(repo.id);
      let temporary;
      try {
        const cwd = location(repo);
        const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
        delete env.DEPLOY_TOKEN;
        const tracked = !!(await exec('git', ['ls-files', '--', '.env'], { cwd, env, maxBuffer: 1024 * 1024 })).stdout.trim();
        const file = path.join(cwd, '.env');
        let stat;
        try {
          stat = fs.lstatSync(file);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
          return send(res, 409, { error: 'The repository .env must be a regular file, not a symlink or directory' });
        }
        if (req.method === 'GET') {
          if (stat && stat.size > 65536) return send(res, 409, { error: 'Existing environment file exceeds 64 KiB' });
          return send(res, 200, { exists: !!stat, tracked, content: stat ? fs.readFileSync(file, 'utf8') : '' });
        }
        if (tracked) return send(res, 409, { error: 'The repository tracks .env in Git. Remove it from version control before editing it here to avoid conflicts and exposing secrets.' });
        temporary = path.join(cwd, `.git-deploy-env-${crypto.randomUUID()}.tmp`);
        fs.writeFileSync(temporary, input.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
        temporary = undefined;
        return send(res, 200, { ok: true });
      } finally {
        if (temporary) fs.rmSync(temporary, { force: true });
        active.delete(repo.id);
      }
    }
    if (match[2] === 'clone' && req.method === 'POST') {
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      if (repo.status !== 'awaiting-key' && !repo.cloneFailed) return send(res, 409, { error: 'Repository is not awaiting a clone' });
      if (repo.cloneFailed) fs.rmSync(location(repo), { recursive: true, force: true });
      void clone(repo);
      return send(res, 202, repo);
    }
    if (match[2] === 'deploy' && req.method === 'POST') {
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      if (!fs.existsSync(path.join(location(repo), '.git'))) return send(res, 409, { error: 'Clone failed; add the repository again' });
      void deploy(repo);
      return send(res, 202, repo);
    }
    if (!match[2] && req.method === 'PATCH') {
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      const input = await body(req);
      if (!repos.includes(repo)) return send(res, 404, { error: 'Not found' });
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      if ((input.script !== undefined && (typeof input.script !== 'string' || input.script.length > 10000)) ||
          (input.watching !== undefined && typeof input.watching !== 'boolean') ||
          (input.auth !== undefined && (repo.authType !== 'token' || !validTokenAuth(input.auth, repo.url)))) return send(res, 400, { error: 'Invalid settings' });
      if (input.auth !== undefined) fs.writeFileSync(credentialsPath(repo), JSON.stringify(input.auth), { mode: 0o600 });
      if (input.script !== undefined) repo.script = input.script;
      if (input.watching !== undefined && input.watching !== repo.watching) {
        repo.watching = input.watching;
        append(repo, input.watching ? 'Watching resumed.\n' : 'Watching paused.\n');
      }
      if (input.auth !== undefined) append(repo, 'Repository token updated.\n');
      save();
      return send(res, 200, repo);
    }
    if (!match[2] && req.method === 'DELETE') {
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      const input = req.headers['content-length'] || req.headers['transfer-encoding'] ? await body(req) : {};
      if (!repos.includes(repo)) return send(res, 404, { error: 'Not found' });
      if ((input.containers !== undefined && typeof input.containers !== 'boolean') ||
          (input.images !== undefined && typeof input.images !== 'boolean') || (input.images && !input.containers)) {
        return send(res, 400, { error: 'Invalid cleanup options' });
      }
      if (input.containers && !fs.existsSync(path.join(location(repo), '.git'))) {
        return send(res, 409, { error: 'Cannot run Compose cleanup without a cloned repository' });
      }
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      active.add(repo.id);
      try {
        if (input.containers) {
          repo.status = 'removing';
          save();
          await run(repo, 'docker', ['compose', 'down', ...(input.images ? ['--rmi', 'local'] : [])], location(repo));
        }
        fs.rmSync(location(repo), { recursive: true, force: true });
        for (const file of [credentialsPath(repo), path.join(credentialsDir, `${repo.id}.key`), path.join(credentialsDir, `${repo.id}.key.pub`)]) fs.rmSync(file, { force: true });
        append(repo, 'Repository removed.\n');
        repos = repos.filter(item => item !== repo);
        save();
        return send(res, 200, { ok: true });
      } catch (error) {
        repo.status = 'error';
        repo.message = `Removal failed: ${error.message}`;
        save();
        return send(res, 500, { error: repo.message });
      } finally {
        active.delete(repo.id);
      }
    }
    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof SyntaxError || error.message === 'Request too large' || error.message === 'Invalid request') return send(res, 400, { error: error.message });
    console.error(error);
    return send(res, 500, { error: 'Internal server error' });
  }
});

server.listen(port, host, () => console.log(`Git Deploy listening on ${host}:${port}`));
setInterval(() => {
  for (const repo of repos) {
    if (repo.watching && repo.lastDeployed && repo.status === 'deployed' && !active.has(repo.id)) void check(repo);
  }
}, interval * 1000).unref();
