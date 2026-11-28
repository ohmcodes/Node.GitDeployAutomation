'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validOwner, validOwnerPaths, deployFilesInside, applyOwner } = require('../lib/file-owner');

test('validOwnerPaths accepts relative data folders only', () => {
  assert.equal(validOwnerPaths([]), true);
  assert.equal(validOwnerPaths(['data', 'storage/uploads', '.cache']), true);
  for (const value of [undefined, 'data', [''], ['.'], ['..'], ['/data'], ['data/../..'], ['.git'], ['.GIT/hooks'], ['a b'], ['data/'], [1]]) {
    assert.equal(validOwnerPaths(value), false, JSON.stringify(value));
  }
});

test('deployFilesInside flags Compose files and Dockerfiles', () => {
  assert.deepEqual(deployFilesInside(['data/seed.json', 'app/compose.yaml', 'app/Dockerfile.prod', 'x/docker-compose.override.yml', 'y/.dockerignore']),
    ['app/compose.yaml', 'app/Dockerfile.prod', 'x/docker-compose.override.yml', 'y/.dockerignore']);
});

test('validOwner accepts numeric UID:GID or empty', () => {
  for (const value of ['', '0:0', '1000:1000', '65534:65534']) assert.equal(validOwner(value), true, value);
  for (const value of [undefined, null, 1000, '1000', 'node:node', '1000:', ':1000', '-1:0', '1000:1000:1', ' 1000:1000', '99999999999:0']) {
    assert.equal(validOwner(value), false, String(value));
  }
});

test('applyOwner is a no-op without an owner or paths', () => {
  assert.equal(applyOwner('/does/not/matter', '', ['data']), null);
  assert.equal(applyOwner('/does/not/matter', '1000:1000', []), null);
});

test('applyOwner creates and re-owns only the listed folders and never follows symlinks', { skip: process.platform !== 'linux' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-deploy-owner-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'git-deploy-outside-'));
  try {
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services: {}');
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(path.join(dir, 'config', 'secrets.json'), '{}');
    fs.symlinkSync(outside, path.join(dir, 'config', 'escape'));
    fs.writeFileSync(path.join(outside, 'host-file'), 'x');
    const { uid, gid } = fs.statSync(dir);
    // Re-owning to the current user works without root and exercises the walk:
    // config, secrets.json, the escape symlink itself, plus the new data folder.
    assert.equal(applyOwner(dir, `${uid}:${gid}`, ['config', 'data']), '4 entries in config, data');
    assert.ok(fs.statSync(path.join(dir, 'data')).isDirectory());
    fs.symlinkSync(outside, path.join(dir, 'linked'));
    assert.throws(() => applyOwner(dir, `${uid}:${gid}`, ['linked']), /real folder/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
