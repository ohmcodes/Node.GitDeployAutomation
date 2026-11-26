'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('./lib/commands');
const { validUrl, validBranch, validTokenAuth } = require('./lib/validation');
const { createRepositoryService } = require('./lib/repositories');
const { createMetricsService } = require('./lib/metrics');
const { createSessions } = require('./lib/sessions');
const { createRouter } = require('./lib/router');
const { send, body, optionalBody, createServer } = require('./lib/http');

const root = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const reposDir = path.join(root, 'repos');
const stateFile = path.join(root, 'state.json');
const activityFile = path.join(root, 'activity.json');
const credentialsDir = path.join(root, 'credentials');
const token = process.env.DEPLOY_TOKEN || '';
const interval = Number(process.env.POLL_INTERVAL_SECONDS || 60);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

if (token.length < 16) throw new Error('DEPLOY_TOKEN must be at least 16 characters');
if (!Number.isInteger(interval) || interval < 10) throw new Error('POLL_INTERVAL_SECONDS must be an integer of at least 10');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
fs.mkdirSync(reposDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
let repos = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : [];
if (!Array.isArray(repos)) throw new Error('Invalid state file');
let activity = fs.existsSync(activityFile) ? JSON.parse(fs.readFileSync(activityFile, 'utf8')) : [];
if (!Array.isArray(activity)) throw new Error('Invalid activity file');
const active = new Set();
function save() {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(repos, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

for (const repo of repos) {
  if (['cloning', 'deploying', 'rebuilding', 'checking', 'removing'].includes(repo.status)) {
    if (repo.status === 'cloning') repo.cloneFailed = true;
    repo.status = 'error';
    repo.message = 'Operation interrupted by restart. Deploy manually to retry.';
  }
}
save();

function append(repo, text) {
  repo.log = ((repo.log || '') + text).slice(-40000);
  activity.push({ time: new Date().toISOString(), repoId: repo.id, url: repo.url, text: text.slice(-40000) });
  activity = activity.slice(-200);
  const tmp = `${activityFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(activity), { mode: 0o600 });
  fs.renameSync(tmp, activityFile);
  save();
}

const { credentialsPath, location, run, clone, deploy, check, pageDomain, publishedPorts, dockerOutput, managedContainers } =
  createRepositoryService({ reposDir, credentialsDir, active, save, append, exec });
const { metrics } = createMetricsService({ getRepos: () => repos, location, exec });

const auth = createSessions({ root, token, send, body });
const route = createRouter({ repos, getActivity: () => activity, active, credentialsDir, save, append, exec,
  credentialsPath, location, run, clone, deploy, pageDomain, publishedPorts, dockerOutput, managedContainers,
  metrics, validUrl, validBranch, validTokenAuth, auth, send, body, optionalBody });
const server = createServer(route);

server.listen(port, host, () => console.log(`Git Deploy listening on ${host}:${port}`));
setInterval(() => {
  for (const repo of repos) {
    if (repo.watching && repo.lastDeployed && repo.status === 'deployed' && !active.has(repo.id)) void check(repo);
  }
}, interval * 1000).unref();
