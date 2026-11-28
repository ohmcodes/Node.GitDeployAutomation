'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writableMounts, parseNumber, plainPath, chownArgs } = require('../lib/auto-permissions');

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
    `/var/run/docker.sock (host path ${path.resolve('/var/run/docker.sock')} is outside the repository; prepare its owner on the host)`,
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

test('chown one-off container adds back the capabilities a cap_drop: ALL service removes', () => {
  const args = chownArgs('crondns', '1000:1000', ['/data']);
  assert.deepEqual(args.slice(0, 7), ['compose', 'run', '--rm', '--no-deps', '-T', '--user', '0']);
  for (const cap of ['CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'DAC_READ_SEARCH']) {
    const index = args.indexOf(cap);
    assert.ok(index > 0 && args[index - 1] === '--cap-add', `missing --cap-add ${cap}`);
  }
  // Options must come before the service name, chown arguments after it.
  assert.deepEqual(args.slice(args.indexOf('--entrypoint')), ['--entrypoint', 'chown', 'crondns', '-R', '-h', '1000:1000', '/data']);
  assert.ok(!args.includes('--privileged'));
});
