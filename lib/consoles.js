'use strict';

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const docker = require('./docker-api');

// Prefer bash, fall back to sh for minimal images (Alpine, BusyBox).
const SHELL = ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'];
const TICKET_LIFETIME = 30 * 1000;
const IDLE_LIMIT = 30 * 60 * 1000;
const MAX_CONSOLES = 10;
const MAX_BUFFERED = 1024 * 1024;

// Interactive container consoles over WebSocket.
// Flow: an authenticated POST (with a fresh authenticator code) issues a single-use ticket,
// then the browser opens /api/console?ticket=… . Browsers cannot send an Authorization header
// on a WebSocket, so the ticket carries the session; it never goes into a log or the state file.
function createConsoles({ auth, repos, append }) {
  const tickets = new Map();
  const open = new Set();

  function issue({ sessionHash, repo, container, root }) {
    const now = Date.now();
    for (const [key, item] of tickets) if (item.expires <= now) tickets.delete(key);
    const ticket = crypto.randomBytes(32).toString('base64url');
    tickets.set(ticket, { sessionHash, repoId: repo.id, containerId: container.id, name: container.name || container.id, root, expires: now + TICKET_LIFETIME });
    return ticket;
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function reject(socket, status, text) {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  async function session(ws, grant) {
    const repo = repos.find(item => item.id === grant.repoId);
    const user = grant.root ? '0' : '';
    const label = `${grant.name}${grant.root ? ' as root' : ''}`;
    let stream;
    let execId;
    let closed = false;
    let lastInput = Date.now();
    let size = null;
    const pending = [];
    const timer = setInterval(() => {
      if (!auth.isValid(grant.sessionHash)) ws.close(4401, 'Session ended');
      else if (Date.now() - lastInput > IDLE_LIMIT) ws.close(4408, 'Idle timeout');
    }, 15000);
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      open.delete(ws);
      if (stream) {
        // Docker does not kill exec processes when the stream closes; interrupt the
        // foreground job and end the shell so nothing is left running (best effort).
        try { stream.write('\x03\x03\nexit\n'); } catch { /* already closed */ }
        stream.end();
        setTimeout(() => stream.destroy(), 1000).unref();
      }
    };
    const resize = () => {
      if (execId && size) docker.resizeExec(execId, size.cols, size.rows).catch(() => {});
    };
    // Listen straight away: the browser sends its size (and maybe keystrokes) as soon as the
    // socket opens, which is before Docker has started the shell.
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { return; }
      if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 65536) {
        lastInput = Date.now();
        if (stream) stream.write(message.data);
        else if (pending.length < 100) pending.push(message.data);
      } else if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows) &&
          message.cols > 0 && message.cols <= 1000 && message.rows > 0 && message.rows <= 500) {
        size = { cols: message.cols, rows: message.rows };
        resize();
      }
    });
    ws.on('close', () => {
      if (stream && repo) append(repo, `Console closed on container ${label}.\n`);
      finish();
    });
    ws.on('error', finish);
    if (!repo) return ws.close(4404, 'Repository not found');
    try {
      execId = await docker.createExec(grant.containerId, { user, cmd: SHELL });
      stream = await docker.startExec(execId);
    } catch (error) {
      if (ws.readyState === ws.OPEN) {
        ws.send(Buffer.from(`\r\nUnable to open console: ${error.message}\r\n`));
        ws.close(4500, 'Console failed');
      }
      return finish();
    }
    if (closed || ws.readyState !== ws.OPEN) {
      // The browser left while Docker was starting the shell.
      closed = false;
      return finish();
    }
    append(repo, `Console opened on container ${label}.\n`);
    resize();
    for (const data of pending.splice(0)) stream.write(data);
    stream.on('data', chunk => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(chunk);
      // Backpressure: stop reading from Docker while the browser is behind.
      if (ws.bufferedAmount > MAX_BUFFERED) {
        stream.pause();
        const drain = setInterval(() => {
          if (ws.readyState !== ws.OPEN || ws.bufferedAmount < MAX_BUFFERED / 4) {
            clearInterval(drain);
            if (ws.readyState === ws.OPEN) stream.resume();
          }
        }, 50);
      }
    });
    stream.on('end', () => ws.close(1000, 'Shell exited'));
    stream.on('error', () => ws.close(1011, 'Stream error'));
  }

  function attach(server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return reject(socket, 400, 'Bad Request'); }
      if (url.pathname !== '/api/console') return reject(socket, 404, 'Not Found');
      if (!sameOrigin(req)) return reject(socket, 403, 'Forbidden');
      const ticket = url.searchParams.get('ticket') || '';
      const grant = tickets.get(ticket);
      tickets.delete(ticket);
      if (!grant || grant.expires <= Date.now() || !auth.isValid(grant.sessionHash)) return reject(socket, 401, 'Unauthorized');
      if (open.size >= MAX_CONSOLES) return reject(socket, 429, 'Too Many Requests');
      // Reserve the slot synchronously so simultaneous upgrades cannot exceed the limit.
      const slot = Symbol('console');
      open.add(slot);
      socket.once('close', () => open.delete(slot));
      wss.handleUpgrade(req, socket, head, ws => {
        open.delete(slot);
        open.add(ws);
        void session(ws, grant);
      });
    });
  }

  return { issue, attach };
}

module.exports = { createConsoles };
