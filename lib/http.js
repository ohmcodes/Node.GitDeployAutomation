'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function body(req, limit = 32768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid request');
  return value;
}

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/containers.js': ['containers.js', 'text/javascript; charset=utf-8'],
  '/metrics.js': ['metrics.js', 'text/javascript; charset=utf-8'],
  '/preferences.js': ['preferences.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/console.js': ['console.js', 'text/javascript; charset=utf-8'],
  // Terminal emulator served from node_modules so the dashboard works offline and needs no CDN.
  '/vendor/xterm.mjs': ['../node_modules/@xterm/xterm/lib/xterm.mjs', 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': ['../node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
  '/vendor/addon-fit.mjs': ['../node_modules/@xterm/addon-fit/lib/addon-fit.mjs', 'text/javascript; charset=utf-8']
};
async function optionalBody(req) {
  return (req.headers['content-length'] && req.headers['content-length'] !== '0') || req.headers['transfer-encoding'] ? body(req) : {};
}

function createServer(route) {
  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return send(res, 400, { error: 'Invalid request URL' });
    }
    if (req.method === 'GET' && assets[pathname]) {
      const [file, type] = assets[pathname];
      res.writeHead(200, {
        'Content-Type': type, 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(path.join(__dirname, '..', 'public', file)).pipe(res);
      return;
    }
    if (!pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    return route(req, res, pathname);
  });
  return server;
}

module.exports = { send, body, optionalBody, createServer };
