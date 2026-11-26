'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readRepositoryIcon } = require('./repository-icon');

function createRepositoryRoutes({ repos, active, credentialsDir, save, append, exec, credentialsPath, location, run, clone, deploy, pageDomain, publishedPorts, validUrl, validBranch, validTokenAuth, auth, send, body, optionalBody }) {
  return async function repositoryRoute(req, res, pathname, { currentSession, sessionHash }) {
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
    const match = pathname.match(/^\/api\/repos\/([0-9a-f-]{36})(?:\/(deploy|clone|env|page|icon))?$/);
    const repo = match && repos.find(item => item.id === match[1]);
    if (!repo) return send(res, 404, { error: 'Not found' });
    if (match[2] === 'icon' && req.method === 'GET') {
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      if (repo.cloneFailed || repo.status === 'awaiting-key') return send(res, 200, { icon: null });
      return send(res, 200, { icon: readRepositoryIcon(location(repo)) });
    }
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
      const input = await optionalBody(req);
      if (!repos.includes(repo)) return send(res, 404, { error: 'Not found' });
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      if (!fs.existsSync(path.join(location(repo), '.git'))) return send(res, 409, { error: 'Clone failed; add the repository again' });
      if (!auth.authorizeAction(res, currentSession, sessionHash, input.authCode)) return;
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
      const input = await optionalBody(req);
      if (!repos.includes(repo)) return send(res, 404, { error: 'Not found' });
      if ((input.containers !== undefined && typeof input.containers !== 'boolean') ||
          (input.images !== undefined && typeof input.images !== 'boolean') || (input.images && !input.containers)) {
        return send(res, 400, { error: 'Invalid cleanup options' });
      }
      if (input.containers && !fs.existsSync(path.join(location(repo), '.git'))) {
        return send(res, 409, { error: 'Cannot run Compose cleanup without a cloned repository' });
      }
      if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
      if (!auth.authorizeAction(res, currentSession, sessionHash, input.authCode)) return;
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
        repos.splice(repos.indexOf(repo), 1);
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
  };
}

module.exports = { createRepositoryRoutes };
