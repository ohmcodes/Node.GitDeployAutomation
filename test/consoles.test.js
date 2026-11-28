'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createConsoles } = require('../lib/consoles');
const { dockerEndpoint } = require('../lib/docker-api');

async function harness(valid = () => true) {
  const consoles = createConsoles({ auth: { isValid: valid }, repos: [], append: () => {} });
  const server = http.createServer((req, res) => res.end());
  consoles.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `ws://127.0.0.1:${server.address().port}`;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const connect = (path, headers = { Origin: origin }) => new Promise(resolve => {
    const ws = new WebSocket(`${base}${path}`, { headers });
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('error', () => {});
  });
  return { consoles, server, connect };
}

const grant = { sessionHash: 'session', repo: { id: 'repo' }, container: { id: 'abc123abc123', name: 'app' }, root: false };

test('console upgrade rejects unknown paths, missing tickets and foreign origins', async () => {
  const { consoles, server, connect } = await harness();
  try {
    assert.equal(await connect('/api/other'), 404);
    assert.equal(await connect('/api/console?ticket=nope'), 401);
    const ticket = consoles.issue(grant);
    assert.equal(await connect(`/api/console?ticket=${ticket}`, { Origin: 'https://evil.example' }), 403);
  } finally {
    server.close();
  }
});

test('console tickets are single use and require a live session', async () => {
  let alive = true;
  const { consoles, server, connect } = await harness(() => alive);
  try {
    const ticket = consoles.issue(grant);
    assert.equal(await connect(`/api/console?ticket=${ticket}`), 101);
    assert.equal(await connect(`/api/console?ticket=${ticket}`), 401);
    alive = false;
    assert.equal(await connect(`/api/console?ticket=${consoles.issue(grant)}`), 401);
  } finally {
    server.close();
  }
});

test('dockerEndpoint follows DOCKER_HOST like the Docker CLI', () => {
  assert.deepEqual(dockerEndpoint({}, 'linux'), { socketPath: '/var/run/docker.sock' });
  assert.deepEqual(dockerEndpoint({}, 'win32'), { socketPath: '\\\\.\\pipe\\docker_engine' });
  assert.deepEqual(dockerEndpoint({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }), { socketPath: '/run/user/1000/docker.sock' });
  assert.deepEqual(dockerEndpoint({ DOCKER_HOST: 'tcp://10.0.0.5:2375' }), { host: '10.0.0.5', port: 2375 });
  assert.throws(() => dockerEndpoint({ DOCKER_HOST: 'ssh://user@host' }), /does not support/);
  assert.throws(() => dockerEndpoint({ DOCKER_HOST: 'tcp://10.0.0.5:2376', DOCKER_TLS_VERIFY: '1' }), /does not support/);
});
