'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createRepositoryService({ reposDir, credentialsDir, active, save, append, exec }) {
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

  async function dockerOutput(repo, args) {
    const env = { ...process.env };
    delete env.DEPLOY_TOKEN;
    return (await exec('docker', args, { cwd: location(repo), env, maxBuffer: 2 * 1024 * 1024 })).stdout;
  }

  async function managedContainers(repo) {
    const output = (await dockerOutput(repo, ['compose', 'ps', '-a', '--format', 'json'])).trim();
    if (!output) return [];
    let items;
    try {
      items = output.startsWith('[') ? JSON.parse(output) : output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      if (!Array.isArray(items)) throw new Error('Invalid response');
    } catch {
      throw new Error('Docker Compose returned invalid container data');
    }
    if (items.some(item => !item || typeof item.ID !== 'string' || !/^[a-f0-9]{12,64}$/i.test(item.ID))) {
      throw new Error('Docker Compose returned invalid container data');
    }
    return items.map(item => ({
      id: item.ID, name: item.Name, service: item.Service, state: item.State, status: item.Status
    }));
  }


  return { credentialsPath, location, run, clone, deploy, check, pageDomain, publishedPorts, dockerOutput, managedContainers };
}

module.exports = { createRepositoryService };
