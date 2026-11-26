'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readRepositoryIcon } = require('../lib/repository-icon');

test('repository icon discovery uses bounded regular image files in known locations', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-deploy-icon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readRepositoryIcon(root), null);
  fs.mkdirSync(path.join(root, 'public'));
  fs.writeFileSync(path.join(root, 'favicon.png'), 'not a png');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  fs.writeFileSync(path.join(root, 'public', 'icon.svg'), svg);
  assert.equal(readRepositoryIcon(root), `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  fs.writeFileSync(path.join(root, 'favicon.png'), png);
  assert.equal(readRepositoryIcon(root), `data:image/png;base64,${png.toString('base64')}`);
  fs.writeFileSync(path.join(root, 'favicon.png'), Buffer.alloc(128 * 1024 + 1));
  assert.equal(readRepositoryIcon(root), `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
});

test('repository icon discovery does not follow symlinks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-deploy-icon-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  const clone = path.join(root, 'clone');
  fs.mkdirSync(outside);
  fs.mkdirSync(clone);
  fs.writeFileSync(path.join(outside, 'icon.svg'), '<svg></svg>');
  try {
    fs.symlinkSync(outside, path.join(clone, 'public'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('Symlink creation unavailable');
    throw error;
  }
  assert.equal(readRepositoryIcon(clone), null);
});
