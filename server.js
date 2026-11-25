'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const root = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const reposDir = path.join(root, 'repos');
const stateFile = path.join(root, 'state.json');
const token = process.env.DEPLOY_TOKEN || '';
const interval = Number(process.env.POLL_INTERVAL_SECONDS || 60);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

if (token.length < 16) throw new Error('DEPLOY_TOKEN must be at least 16 characters');
if (!Number.isInteger(interval) || interval < 10) throw new Error('POLL_INTERVAL_SECONDS must be an integer of at least 10');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
fs.mkdirSync(reposDir, { recursive: true, mode: 0o700 });
let repos = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : [];
if (!Array.isArray(repos)) throw new Error('Invalid state file');
const active = new Set();

function save() {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(repos, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

for (const repo of repos) {
  if (['cloning', 'deploying', 'checking'].includes(repo.status)) {
    repo.status = 'error';
    repo.message = 'Operation interrupted by restart. Deploy manually to retry.';
  }
}
save();

function append(repo, text) {
  repo.log = ((repo.log || '') + text).slice(-40000);
  save();
}

async function run(repo, program, args, cwd) {
  append(repo, `\n$ ${program} ${args.join(' ')}\n`);
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    delete env.DEPLOY_TOKEN;
    const result = await exec(program, args, { cwd, timeout: 15 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, env });
    append(repo, (result.stdout || '') + (result.stderr || ''));
    return result.stdout.trim();
  } catch (error) {
    append(repo, (error.stdout || '') + (error.stderr || '') + `\n${error.message}\n`);
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
}

async function deployWork(repo) {
  const cwd = location(repo);
  await run(repo, 'git', ['pull', '--ff-only', 'origin', repo.branch], cwd);
  await run(repo, 'docker', ['compose', 'up', '-d', '--build'], cwd);
  if (repo.script) await run(repo, 'sh', ['-c', repo.script], cwd);
  await run(repo, 'docker', ['compose', 'ps'], cwd);
  await run(repo, 'docker', ['compose', 'logs', '--tail=100'], cwd);
  repo.commit = await run(repo, 'git', ['rev-parse', 'HEAD'], cwd);
  repo.lastDeployed = new Date().toISOString();
}

function deploy(repo) {
  return exclusive(repo, 'deploying', () => deployWork(repo));
}

function check(repo) {
  return exclusive(repo, 'checking', async () => {
    const cwd = location(repo);
    await run(repo, 'git', ['fetch', 'origin', repo.branch], cwd);
    const remote = await run(repo, 'git', ['rev-parse', 'FETCH_HEAD'], cwd);
    if (remote !== repo.commit) {
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

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 32768) throw new Error('Request too large');
  }
  const value = JSON.parse(data);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid request');
  return value;
}

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
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
    if (pathname === '/api/repos' && req.method === 'POST') {
      const input = await body(req);
      const branch = input.branch || 'main';
      const script = input.script || '';
      if (!validUrl(input.url) || !validBranch(branch) || typeof script !== 'string' || script.length > 10000) {
        return send(res, 400, { error: 'Invalid URL, branch, or script' });
      }
      const repo = { id: crypto.randomUUID(), url: input.url, branch, script, watching: true, status: 'ready', message: '', log: '', commit: null, lastDeployed: null, lastChecked: null };
      repos.push(repo);
      save();
      void clone(repo);
      return send(res, 202, repo);
    }
    const match = pathname.match(/^\/api\/repos\/([0-9a-f-]{36})(?:\/(deploy))?$/);
    const repo = match && repos.find(item => item.id === match[1]);
    if (!repo) return send(res, 404, { error: 'Not found' });
    if (match[2] === 'deploy' && req.method === 'POST') {
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      if (!fs.existsSync(path.join(location(repo), '.git'))) return send(res, 409, { error: 'Clone failed; add the repository again' });
      void deploy(repo);
      return send(res, 202, repo);
    }
    if (!match[2] && req.method === 'PATCH') {
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      const input = await body(req);
      if ((input.script !== undefined && (typeof input.script !== 'string' || input.script.length > 10000)) ||
          (input.watching !== undefined && typeof input.watching !== 'boolean')) return send(res, 400, { error: 'Invalid settings' });
      if (input.script !== undefined) repo.script = input.script;
      if (input.watching !== undefined) repo.watching = input.watching;
      save();
      return send(res, 200, repo);
    }
    if (!match[2] && req.method === 'DELETE') {
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      repos = repos.filter(item => item !== repo);
      save();
      fs.rmSync(location(repo), { recursive: true, force: true });
      return send(res, 200, { ok: true });
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
