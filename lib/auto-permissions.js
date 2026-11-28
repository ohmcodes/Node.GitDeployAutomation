'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { deployFilesInside } = require('./file-owner');

// Automatic permissions: before `docker compose up`, make the writable mounts of every non-root
// service owned by the user that service runs as.
//
// How: read the resolved Compose configuration, collect each service's writable mounts (named
// volumes and bind mounts inside the clone), detect each service's uid/gid by running `id` in a
// one-off container of that service, then run `chown -R -h` as root in another one-off container
// of the same service. `-h` re-owns symlinks themselves and never follows them, so nothing the
// app plants inside a mount can redirect the change to another file.
//
// Never touched: read-only mounts, host paths outside the clone, the whole repository, `.git`,
// the `.env` files Compose reads, folders holding Compose files or Dockerfiles, bind sources
// that are (or pass through) a symlink, external volumes, folders the manual File owner covers,
// and mounts shared by services running as different users. Problems are logged as warnings and
// never fail the deployment.

// True when no existing component of `rel` (relative to cwd) is a symlink. Missing components
// are fine: Docker creates them as plain folders.
function plainPath(cwd, rel) {
  let current = cwd;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      return false;
    }
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}

function envFiles(service, cwd) {
  const files = [path.join(cwd, '.env')];
  for (const item of [].concat(service.env_file || [])) {
    const file = typeof item === 'string' ? item : item && item.path;
    if (typeof file === 'string') files.push(path.resolve(cwd, file));
  }
  return files;
}

// Returns { mounts: [{ target, key }], skipped: [text] } for one service.
function writableMounts(service, cwd, trackedFiles, { externalVolumes = new Set(), ownerPaths = [], name = '' } = {}) {
  const mounts = [];
  const skipped = [];
  const protectedFiles = envFiles(service, cwd);
  for (const volume of service.volumes || []) {
    if (!volume || volume.read_only || !volume.target) continue;
    if (volume.type === 'volume') {
      if (volume.source && externalVolumes.has(volume.source)) {
        skipped.push(`${volume.target} (external volume ${volume.source})`);
        continue;
      }
      mounts.push({ target: volume.target, key: volume.source ? `volume:${volume.source}` : `anonymous:${name}:${volume.target}` });
      continue;
    }
    if (volume.type !== 'bind' || typeof volume.source !== 'string') continue;
    const rel = path.relative(cwd, volume.source);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // host path outside the clone
    const prefix = rel.split(path.sep).join('/');
    const reason =
      rel === '' ? 'mounts the whole repository' :
        prefix.split('/')[0].toLowerCase() === '.git' ? 'is Git metadata' :
          protectedFiles.some(file => file === volume.source || file.startsWith(volume.source + path.sep)) ? 'holds an environment file Compose reads' :
            deployFilesInside(trackedFiles.filter(file => file === prefix || file.startsWith(`${prefix}/`))).length ? 'contains Compose files or Dockerfiles' :
              ownerPaths.some(item => prefix === item || prefix.startsWith(`${item}/`)) ? 'is covered by the manual File owner' :
                !plainPath(cwd, rel) ? 'is or passes through a symlink' : '';
    if (reason) skipped.push(`${volume.target} (${reason})`);
    else mounts.push({ target: volume.target, key: `bind:${volume.source}` });
  }
  return { mounts, skipped };
}

function parseNumber(output) {
  const value = String(output).trim();
  return /^\d{1,10}$/.test(value) ? Number(value) : null;
}

function createAutoPermissions({ run, exec, childEnv, append }) {
  async function config(cwd) {
    // Not logged: the resolved configuration includes environment values (secrets).
    const { stdout } = await exec('docker', ['compose', 'config', '--format', 'json'], { cwd, env: childEnv(), maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  }

  async function probe(repo, cwd, name, flag) {
    try {
      // Explicit arguments, so the service's own `command:` is never appended to `id`.
      return parseNumber(await run(repo, 'docker', ['compose', 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'id', name, flag], cwd));
    } catch {
      return null;
    }
  }

  return async function autoPermissions(repo, cwd) {
    const note = text => append(repo, `\nAutomatic permissions: ${text}\n`);
    let resolved;
    try {
      resolved = await config(cwd);
    } catch (error) {
      note(`skipped, could not read the Compose configuration (${String(error.message).split('\n')[0]}).`);
      return;
    }
    const tracked = (await run(repo, 'git', ['ls-files'], cwd, { quiet: true })).split(/\r?\n/).filter(Boolean);
    const externalVolumes = new Set(Object.entries(resolved.volumes || {}).filter(([, item]) => item && item.external).map(([key]) => key));
    const ownerPaths = repo.fileOwner ? repo.fileOwnerPaths || [] : [];
    const plan = [];
    for (const [name, service] of Object.entries(resolved.services || {})) {
      const { mounts, skipped } = writableMounts(service, cwd, tracked, { externalVolumes, ownerPaths, name });
      for (const item of skipped) note(`${name} ${item} left unchanged.`);
      if (mounts.length) plan.push({ name, mounts, build: !!service.build });
    }
    if (!plan.length) {
      note('no writable volumes or folders to prepare.');
      return;
    }
    // Detect users from the images this deployment will run, not stale ones.
    if (plan.some(item => item.build)) {
      try {
        await run(repo, 'docker', ['compose', 'build'], cwd);
      } catch {
        note('build failed; skipped (Compose will report the build error).');
        return;
      }
    }
    for (const item of plan) {
      const uid = await probe(repo, cwd, item.name, '-u');
      const gid = uid === null ? null : await probe(repo, cwd, item.name, '-g');
      item.id = uid === null || gid === null ? null : { uid, gid };
      if (!item.id) note(`could not detect the user of ${item.name} (no "id" command in the image?). Use Settings → Advanced if it needs write access.`);
      else if (item.id.uid === 0) note(`${item.name} runs as root; nothing to change.`);
    }
    // A volume or folder shared by services running as different users cannot belong to both.
    const owners = new Map();
    for (const item of plan) {
      if (!item.id || item.id.uid === 0) continue;
      for (const mount of item.mounts) {
        const set = owners.get(mount.key) || new Set();
        set.add(`${item.id.uid}:${item.id.gid}`);
        owners.set(mount.key, set);
      }
    }
    for (const item of plan) {
      if (!item.id || item.id.uid === 0) continue;
      const targets = [];
      for (const mount of item.mounts) {
        if (owners.get(mount.key).size > 1) note(`${item.name} ${mount.target} is shared by services running as different users (${[...owners.get(mount.key)].join(', ')}); left unchanged.`);
        else targets.push(mount.target);
      }
      if (!targets.length) continue;
      const owner = `${item.id.uid}:${item.id.gid}`;
      try {
        await run(repo, 'docker', ['compose', 'run', '--rm', '--no-deps', '-T', '--user', '0', '--entrypoint', 'chown', item.name, '-R', '-h', owner, ...targets], cwd);
        note(`${targets.join(', ')} in ${item.name} now owned by ${owner}.`);
      } catch {
        note(`could not change ownership in ${item.name} (no chown, dropped capabilities or a read-only/network volume?); continuing.`);
      }
    }
  };
}

module.exports = { createAutoPermissions, writableMounts, parseNumber, plainPath };
