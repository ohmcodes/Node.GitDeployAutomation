'use strict';

const fs = require('node:fs');
const path = require('node:path');

// "UID:GID" with numeric IDs, e.g. "1000:1000". Empty string means "leave ownership alone".
function validOwner(value) {
  if (value === '') return true;
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{1,10}):(\d{1,10})$/);
  return !!match && Number(match[1]) <= 4294967294 && Number(match[2]) <= 4294967294;
}

// Writable paths are folders relative to the clone root, e.g. ["data", "storage/uploads"].
// Never the root itself, never .git, never parent traversal.
function validOwnerPaths(value) {
  return Array.isArray(value) && value.length <= 20 && value.every(item =>
    typeof item === 'string' && item.length > 0 && item.length <= 200 &&
    /^[A-Za-z0-9_.@-]+(\/[A-Za-z0-9_.@-]+)*$/.test(item) &&
    item.split('/').every(part => part !== '.' && part !== '..') &&
    item.split('/')[0].toLowerCase() !== '.git');
}

// Files Compose or Docker read when deploying. If one of these sits inside a folder the app
// can write to, a compromised app could rewrite the next (root-run) deployment.
const DEPLOY_FILE = /(^|\/)((docker-)?compose(\.[^/]*)?\.ya?ml|[^/]*dockerfile[^/]*|\.dockerignore)$/i;

function deployFilesInside(trackedFiles) {
  return trackedFiles.filter(file => DEPLOY_FILE.test(file));
}

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
const DIR_FLAGS = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;

// Gives the named folders (created if missing) and everything inside them to the deployed
// app's user. The app can write to these folders, so it could swap a subfolder for a symlink
// while we walk. To stay race-free, every step goes through an open directory descriptor
// (/proc/self/fd/N/<name>) with O_NOFOLLOW: a symlink is never followed, only re-owned itself.
// Linux only (the supported runtime); other platforms are skipped.
function applyOwner(dir, owner, paths) {
  if (!owner || !paths || !paths.length) return null;
  if (process.platform !== 'linux' || !fs.existsSync('/proc/self/fd')) return 'skipped (requires Linux)';
  const [uid, gid] = owner.split(':').map(Number);
  let count = 0;
  const at = (fd, name) => `/proc/self/fd/${fd}/${name}`;

  function walk(fd) {
    for (const entry of fs.readdirSync(`/proc/self/fd/${fd}`, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        let child;
        try {
          child = fs.openSync(at(fd, entry.name), DIR_FLAGS);
        } catch (error) {
          if (error.code === 'ELOOP' || error.code === 'ENOTDIR' || error.code === 'ENOENT') continue; // swapped mid-walk
          throw error;
        }
        try {
          fs.fchownSync(child, uid, gid);
          count++;
          walk(child);
        } finally {
          fs.closeSync(child);
        }
      } else {
        try {
          fs.lchownSync(at(fd, entry.name), uid, gid);
          count++;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }

  const root = fs.openSync(dir, DIR_FLAGS);
  try {
    for (const item of paths) {
      // Walk down from the clone root one component at a time, refusing symlinks.
      let fd = fs.openSync(`/proc/self/fd/${root}`, DIR_FLAGS);
      try {
        for (const part of item.split('/')) {
          try {
            fs.mkdirSync(at(fd, part), { mode: 0o755 });
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
          let next;
          try {
            next = fs.openSync(at(fd, part), DIR_FLAGS);
          } catch (error) {
            if (error.code === 'ELOOP' || error.code === 'ENOTDIR') throw new Error(`${item} must be a real folder, not a file or symlink`);
            throw error;
          }
          fs.closeSync(fd);
          fd = next;
        }
        fs.fchownSync(fd, uid, gid);
        count++;
        walk(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  } finally {
    fs.closeSync(root);
  }
  return `${count} entries in ${paths.join(', ')}`;
}

module.exports = { validOwner, validOwnerPaths, deployFilesInside, applyOwner };
