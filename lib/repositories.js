'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { applyOwner, deployFilesInside } = require('./file-owner');
const { parseScript } = require('./safe-script');
const crypto = require('node:crypto');
const docker = require('./docker-api');
const { createAutoPermissions } = require('./auto-permissions');

const SCRIPT_LIMIT = 60 * 60 * 1000;

// Environment for Git and Compose child processes: never the dashboard token, and no
// COMPOSE_* settings from Git Deploy's own environment (they would steer project names
// and files for every repository).
function childEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.DEPLOY_TOKEN;
  for (const key of Object.keys(env)) if (/^COMPOSE_/i.test(key)) delete env[key];
  return env;
}

// Git Deploy's own Compose project when it runs in a container (Docker sets HOSTNAME to the
// container ID), or null when it runs directly on a host.
let ownProjectCache;
async function ownProject() {
  if (ownProjectCache === undefined) {
    try {
      const info = await docker.inspectContainer(process.env.HOSTNAME || '');
      ownProjectCache = (info && info.Config && info.Config.Labels && info.Config.Labels['com.docker.compose.project']) || null;
    } catch {
      ownProjectCache = null;
    }
  }
  return ownProjectCache;
}

function createRepositoryService({ reposDir, credentialsDir, active, save, append, stream, exec }) {
  function credentialsPath(repo) {
    return path.join(credentialsDir, `${repo.id}.json`);
  }

  function readCredentials(repo) {
    const file = credentialsPath(repo);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }

  // `quiet`: run without writing the command or its output to the log (internal lookups).
  async function run(repo, program, args, cwd, { quiet = false } = {}) {
    if (!quiet) append(repo, `\n$ ${program} ${args.join(' ')}\n`);
    const credentials = program === 'git' ? readCredentials(repo) : null;
    const secret = credentials && credentials.type === 'token' ? credentials.token : '';
    const redact = text => {
      if (!secret) return text;
      return text.split(secret).join('[REDACTED]').split(Buffer.from(`${credentials.username}:${secret}`).toString('base64')).join('[REDACTED]');
    };
    try {
      const env = childEnv();
      if (credentials && credentials.type === 'token') {
        env.GIT_CONFIG_COUNT = '1';
        env.GIT_CONFIG_KEY_0 = `http.${new URL(repo.url).origin}/.extraheader`;
        env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`${credentials.username}:${secret}`).toString('base64')}`;
      } else if (credentials && credentials.type === 'ssh') {
        const key = path.join(credentialsDir, `${repo.id}.key`);
        env.GIT_SSH_COMMAND = `ssh -i '${key.replace(/'/g, "'\\''")}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes`;
      }
      // Stream output into the card's live log while the command runs. Commands that carry a
      // token are not streamed, because redaction needs the whole text (a secret can be split
      // across chunks); their output appears when they finish.
      const live = !secret && !quiet;
      const onOutput = live ? text => stream(repo, text) : undefined;
      const result = await exec(program, args, { cwd, maxBuffer: 2 * 1024 * 1024, env, onOutput });
      if (!quiet) append(repo, redact((result.stdout || '') + (result.stderr || '')), { activityOnly: live });
      return result.stdout.trim();
    } catch (error) {
      if (quiet) append(repo, `\n$ ${program} ${args.join(' ')}\n`);
      append(repo, redact((error.stdout || '') + (error.stderr || '')), { activityOnly: !secret && !quiet });
      // error.message repeats stderr (already logged above) and is not redacted: log the outcome only.
      const outcome = error.message === 'Command timed out' ? 'Command timed out' : `${program} exited with code ${error.code ?? 'unknown'}`;
      append(repo, `\n${outcome}\n`);
      throw new Error(`${program} failed`);
    }
  }

  // Scripts may only reach the project's own containers. The Compose project name can be
  // changed by COMPOSE_PROJECT_NAME in the repository .env or `name:` in its compose file,
  // so resolve it the way Compose will and refuse Git Deploy's own project.
  async function assertNotSelf(cwd) {
    const own = await ownProject();
    if (!own) return;
    let name;
    try {
      const { stdout } = await exec('docker', ['compose', 'config', '--format', 'json'], { cwd, env: childEnv(), maxBuffer: 8 * 1024 * 1024 });
      name = JSON.parse(stdout).name;
    } catch {
      throw new Error('Could not resolve the Compose project name for the custom script');
    }
    if (typeof name !== 'string' || !name || name === own) {
      throw new Error(`Custom script refused: the Compose project resolves to "${name}", which is Git Deploy itself`);
    }
  }

  const autoPermissions = createAutoPermissions({ run, exec, childEnv, append });

  async function runScript(repo, cwd) {
    if (!repo.script) return;
    let steps;
    try {
      steps = parseScript(repo.script);
    } catch (error) {
      append(repo, `\nCustom script rejected: ${error.message}\n`);
      throw new Error(`Custom script is not allowed: ${error.message}. Edit it in Settings.`);
    }
    if (steps.some(step => step.type === 'command')) await assertNotSelf(cwd);
    const deadline = Date.now() + SCRIPT_LIMIT;
    for (const step of steps) {
      if (Date.now() > deadline) throw new Error('Custom script exceeded 60 minutes');
      if (step.type === 'echo') append(repo, `\n$ echo ${step.text}\n${step.text}\n`);
      else if (step.type === 'sleep') {
        append(repo, `\n$ sleep ${step.seconds}\n`);
        await new Promise(resolve => setTimeout(resolve, step.seconds * 1000));
      } else await run(repo, step.program, step.args, cwd);
    }
  }

  function location(repo) {
    return path.join(reposDir, repo.id);
  }

  // Runs before Compose so the deployed containers can write to bind-mounted folders.
  async function fixOwnership(repo) {
    const paths = repo.fileOwnerPaths || [];
    if (!repo.fileOwner || !paths.length) return;
    const cwd = location(repo);
    // Refuse to make deployment files app-writable (see deployFilesInside).
    const tracked = (await run(repo, 'git', ['ls-files', '--', ...paths], cwd)).split(/\r?\n/).filter(Boolean);
    const risky = deployFilesInside(tracked);
    if (risky.length) throw new Error(`Writable paths contain deployment files (${risky.slice(0, 3).join(', ')}); choose data folders only`);
    try {
      const result = applyOwner(cwd, repo.fileOwner, paths);
      append(repo, `\nFile owner ${repo.fileOwner}: ${result}\n`);
    } catch (error) {
      append(repo, `\nFile owner ${repo.fileOwner} failed: ${error.message}\n`);
      throw new Error(`Could not set file owner: ${error.message}`);
    }
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

  function pendingEnvPath(repo) {
    return path.join(credentialsDir, `${repo.id}.env.pending`);
  }

  // Writes the repository's root .env (owner-only). Refuses a Git-tracked .env and anything
  // that is not a regular file. Returns { warning } when ownership could not be handed over.
  async function writeEnv(repo, content) {
    const cwd = location(repo);
    const tracked = !!(await run(repo, 'git', ['ls-files', '--', '.env'], cwd, { quiet: true }));
    if (tracked) {
      throw Object.assign(new Error('The repository tracks .env in Git. Remove it from version control before editing it here to avoid conflicts and exposing secrets.'), { status: 409 });
    }
    const file = path.join(cwd, '.env');
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      throw Object.assign(new Error('The repository .env must be a regular file, not a symlink or directory'), { status: 409 });
    }
    const temporary = path.join(cwd, `.git-deploy-env-${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    // Keep the saved .env readable by the deployed app's user right away (0600 stays).
    if (repo.fileOwner && process.platform !== 'win32') {
      const [uid, gid] = repo.fileOwner.split(':').map(Number);
      try {
        fs.lchownSync(file, uid, gid);
      } catch (error) {
        return { warning: `Saved, but could not give .env to ${repo.fileOwner}: ${error.message}` };
      }
    }
    return {};
  }

  // A .env supplied when the repository was added is kept (owner-only, outside the clone)
  // until the clone exists, then written like an edit from the .env editor.
  function savePendingEnv(repo, content) {
    fs.writeFileSync(pendingEnvPath(repo), content, { encoding: 'utf8', mode: 0o600 });
  }

  async function applyPendingEnv(repo) {
    const file = pendingEnvPath(repo);
    if (!fs.existsSync(file)) return;
    try {
      const result = await writeEnv(repo, fs.readFileSync(file, 'utf8'));
      fs.rmSync(file, { force: true });
      append(repo, `\n${result.warning || 'Environment file (.env) saved from the repository form.'}\n`);
    } catch (error) {
      // Keep what the user typed: the .env editor offers it until it is saved.
      append(repo, `\nThe .env from the repository form was not saved: ${error.message} It is kept; open .env to review and save it.\n`);
    }
  }

  async function clone(repo) {
    await exclusive(repo, 'cloning', async () => {
      await run(repo, 'git', ['clone', '--branch', repo.branch, '--single-branch', '--', repo.url, location(repo)], reposDir);
      await applyPendingEnv(repo);
    });
    repo.cloneFailed = repo.status === 'error';
    save();
  }

  async function deployWork(repo, forceRecreate = false) {
    const cwd = location(repo);
    await run(repo, 'git', ['pull', '--ff-only', 'origin', repo.branch], cwd);
    repo.lastPulled = new Date().toISOString();
    await fixOwnership(repo);
    repo.status = 'rebuilding';
    repo.composeAttempted = true;
    save();
    if (repo.autoPermissions !== false) await autoPermissions(repo, cwd);
    await run(repo, 'docker', ['compose', 'up', '-d', '--build', ...(forceRecreate ? ['--force-recreate'] : [])], cwd);
    repo.status = 'deploying';
    save();
    await runScript(repo, cwd);
    await run(repo, 'docker', ['compose', 'ps'], cwd);
    await run(repo, 'docker', ['compose', 'logs', '--tail=100'], cwd);
    repo.commit = await run(repo, 'git', ['rev-parse', 'HEAD'], cwd);
    repo.lastDeployed = new Date().toISOString();
  }

  // Manual pull only: updates the working tree without rebuilding or restarting containers.
  // repo.commit still tracks the last *deployed* commit, so a watched repository will deploy
  // the pulled changes on its next check.
  function pull(repo) {
    return exclusive(repo, 'pulling', async () => {
      const cwd = location(repo);
      await run(repo, 'git', ['pull', '--ff-only', 'origin', repo.branch], cwd);
      repo.lastPulled = new Date().toISOString();
      const head = await run(repo, 'git', ['rev-parse', 'HEAD'], cwd);
      append(repo, head === repo.commit ? 'Pull complete; already at the deployed commit.\n' :
        `Pull complete; ${head.slice(0, 12)} is not deployed yet.${repo.watching && repo.lastDeployed ? ' The watcher will deploy it on its next check.' : ' Deploy to apply it.'}\n`);
    });
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


  return { writeEnv, savePendingEnv, pendingEnvPath, credentialsPath, location, run, clone, pull, deploy, check, pageDomain, publishedPorts, dockerOutput, managedContainers, fixOwnership };
}

module.exports = { createRepositoryService };
