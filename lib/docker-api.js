'use strict';

const http = require('node:http');

// Talks to the Docker Engine API directly (not the CLI) because an interactive console
// needs a hijacked, TTY-backed exec stream that the CLI can only provide from a real terminal.
// Supports the same local endpoints the CLI uses by default; TLS and SSH hosts are not supported.
function dockerEndpoint(env = process.env, platform = process.platform) {
  const value = env.DOCKER_HOST || '';
  if (!value) return platform === 'win32' ? { socketPath: '\\\\.\\pipe\\docker_engine' } : { socketPath: '/var/run/docker.sock' };
  if (value.startsWith('unix://')) return { socketPath: value.slice('unix://'.length) };
  if (value.startsWith('npipe://')) return { socketPath: value.slice('npipe://'.length).replace(/\//g, '\\') };
  if (value.startsWith('tcp://') && !env.DOCKER_TLS_VERIFY) {
    const url = new URL(value.replace(/^tcp:/, 'http:'));
    return { host: url.hostname, port: Number(url.port || 2375) };
  }
  throw new Error(`Console does not support DOCKER_HOST=${value.split('://')[0]}:// (use a local socket or plain tcp://)`);
}

function request(method, path, payload, extraHeaders = {}) {
  const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request({
      ...dockerEndpoint(), method, path,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...extraHeaders }
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Docker API timed out')));
    // Interactive exec start: Docker switches protocols and hands back the raw stream.
    req.on('upgrade', (res, socket, head) => {
      req.setTimeout(0);
      if (head && head.length) socket.unshift(head);
      resolve({ status: res.statusCode, socket });
    });
    req.on('response', res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = text;
        try { body = text ? JSON.parse(text) : null; } catch { /* plain text error */ }
        if (res.statusCode >= 400) {
          const message = body && typeof body === 'object' && body.message ? body.message : String(text || res.statusCode);
          return reject(new Error(message));
        }
        resolve({ status: res.statusCode, body });
      });
    });
    req.end(data);
  });
}

async function createExec(containerId, { user, cmd }) {
  const { body } = await request('POST', `/containers/${encodeURIComponent(containerId)}/exec`, {
    AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
    Env: ['TERM=xterm-256color'], Cmd: cmd, ...(user ? { User: user } : {})
  });
  if (!body || typeof body.Id !== 'string') throw new Error('Docker did not return an exec ID');
  return body.Id;
}

async function startExec(execId) {
  const result = await request('POST', `/exec/${encodeURIComponent(execId)}/start`, { Detach: false, Tty: true },
    { Connection: 'Upgrade', Upgrade: 'tcp' });
  if (!result.socket) throw new Error('Docker did not open an interactive stream');
  return result.socket;
}

async function inspectContainer(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) throw new Error('Invalid container ID');
  return (await request('GET', `/containers/${encodeURIComponent(id)}/json`)).body;
}

function resizeExec(execId, cols, rows) {
  return request('POST', `/exec/${encodeURIComponent(execId)}/resize?h=${rows}&w=${cols}`);
}

module.exports = { dockerEndpoint, createExec, startExec, resizeExec, inspectContainer };
