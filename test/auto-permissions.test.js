'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writableMounts, parseNumber, plainPath } = require('../lib/auto-permissions');

const cwd = path.resolve('/srv/git-deploy/repos/abc');
const at = rel => path.join(cwd, rel);

test('writableMounts picks safe named volumes and bind mounts inside the clone only', () => {
  const service = {
    env_file: ['config/app.env'],
    volumes: [
      { type: 'volume', source: 'app-data', target: '/data' },
      { type: 'volume', target: '/anon' },
      { type: 'volume', source: 'shared-ext', target: '/ext' },
      { type: 'bind', source: at('uploads'), target: '/app/uploads' },
      { type: 'bind', source: at('ro'), target: '/app/ro', read_only: true },
      { type: 'bind', source: path.resolve('/var/run/docker.sock'), target: '/var/run/docker.sock' },
      { type: 'bind', source: cwd, target: '/app' },
      { type: 'bind', source: at('deploy'), target: '/deploy' },
      { type: 'bind', source: at('.git'), target: '/repo' },
      { type: 'bind', source: at('.env'), target: '/app/.env' },
      { type: 'bind', source: at('config'), target: '/app/config' },
      { type: 'bind', source: at('manual'), target: '/manual' },
      { type: 'tmpfs', target: '/tmp' }
    ]
  };
  const { mounts, skipped } = writableMounts(service, cwd, ['deploy/compose.yaml', 'uploads/.gitkeep'], {
    externalVolumes: new Set(['shared-ext']), ownerPaths: ['manual'], name: 'app'
  });
  assert.deepEqual(mounts, [
    { target: '/data', key: 'volume:app-data' },
    { target: '/anon', key: 'anonymous:app:/anon' },
    { target: '/app/uploads', key: `bind:${at('uploads')}` }
  ]);
  assert.deepEqual(skipped, [
    '/ext (external volume shared-ext)',
    '/app (mounts the whole repository)',
    '/deploy (contains Compose files or Dockerfiles)',
    '/repo (is Git metadata)',
    '/app/.env (holds an environment file Compose reads)',
    '/app/config (holds an environment file Compose reads)',
    '/manual (is covered by the manual File owner)'
  ]);
  assert.deepEqual(writableMounts({}, cwd, []), { mounts: [], skipped: [] });
});

test('plainPath refuses bind sources that pass through a symlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-deploy-plain-'));
  try {
    fs.mkdirSync(path.join(dir, 'data'));
    assert.equal(plainPath(dir, 'data'), true);
    assert.equal(plainPath(dir, path.join('data', 'missing', 'deeper')), true);
    try {
      fs.symlinkSync(os.tmpdir(), path.join(dir, 'data', 'cache'), 'dir');
    } catch {
      return; // creating symlinks needs extra rights on Windows
    }
    assert.equal(plainPath(dir, path.join('data', 'cache')), false);
    assert.equal(plainPath(dir, path.join('data', 'cache', 'x')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseNumber reads id -u / id -g output', () => {
  assert.equal(parseNumber('1000\n'), 1000);
  assert.equal(parseNumber('0'), 0);
  assert.equal(parseNumber('exec: "id": executable file not found'), null);
});
