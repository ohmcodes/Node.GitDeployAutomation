'use strict';

const fs = require('node:fs');
const path = require('node:path');

const directories = [[], ['public'], ['static'], ['assets'], ['public', 'assets'], ['src', 'assets'], ['app']];
const names = ['favicon.ico', 'favicon.png', 'icon.png', 'logo.png', 'favicon.svg', 'icon.svg', 'logo.svg'];
const maxBytes = 128 * 1024;

function readRepositoryIcon(root) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  for (const directory of directories) {
    for (const name of names) {
      let current = root;
      let valid = true;
      for (const part of [...directory, name]) {
        current = path.join(current, part);
        let stat;
        try {
          stat = fs.lstatSync(current);
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { valid = false; break; }
          throw error;
        }
        if (stat.isSymbolicLink() || (part === name ? !stat.isFile() || stat.size > maxBytes : !stat.isDirectory())) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      const data = fs.readFileSync(current);
      if (data.length > maxBytes) continue;
      let mime;
      if (name.endsWith('.png') && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mime = 'image/png';
      else if (name.endsWith('.ico') && data.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) mime = 'image/x-icon';
      else if (name.endsWith('.svg') && /<svg(?:\s|>)/i.test(data.toString('utf8').slice(0, 1024))) mime = 'image/svg+xml';
      if (mime) return `data:${mime};base64,${data.toString('base64')}`;
    }
  }
  return null;
}

module.exports = { readRepositoryIcon };
