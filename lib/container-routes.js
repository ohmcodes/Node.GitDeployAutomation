'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createContainerRoutes({ repos, active, auth, send, optionalBody, managedContainers, dockerOutput, exec, location, append, consoles }) {
  return async function containerRoute(req, res, containerMatch, { currentSession, sessionHash }) {
    const repo = repos.find(item => item.id === containerMatch[1]);
    if (!repo) return send(res, 404, { error: 'Not found' });
    // Available as soon as the clone exists, so containers can be fixed after a failed deploy.
    if (repo.cloneFailed || repo.status === 'awaiting-key' || !fs.existsSync(path.join(location(repo), '.git'))) return send(res, 409, { error: 'Clone the repository first' });
    if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
    const action = containerMatch[3] && containerMatch[3].toLowerCase();
    if ((!action && req.method !== 'GET') || (action && (['inspect', 'logs', 'processes'].includes(action) ? req.method !== 'GET' : req.method !== 'POST'))) return send(res, 404, { error: 'Not found' });
    const input = ['stop', 'kill', 'restart', 'pause', 'console'].includes(action) ? await optionalBody(req) : {};
    if (action === 'console' && input.root !== undefined && typeof input.root !== 'boolean') return send(res, 400, { error: 'Invalid console options' });
    if (active.has(repo.id)) return send(res, 409, { error: 'Repository is busy' });
    if (!repos.includes(repo)) return send(res, 404, { error: 'Not found' });
    active.add(repo.id);
    try {
      const containers = await managedContainers(repo);
      if (!action) return send(res, 200, containers);
      const matched = containers.filter(item => item.id.toLowerCase() === containerMatch[2].toLowerCase());
      if (matched.length !== 1) return send(res, 404, { error: 'Container is not part of this Compose project' });
      const id = matched[0].id;
      if (action === 'inspect') {
        const output = await dockerOutput(repo, ['inspect', id]);
        const inspection = JSON.parse(output);
        if (!Array.isArray(inspection) || inspection.length !== 1) throw new Error('Docker returned invalid inspection data');
        return send(res, 200, { data: inspection[0] });
      }
      if (action === 'logs') {
        const env = { ...process.env };
        delete env.DEPLOY_TOKEN;
        const output = await exec('docker', ['logs', '--tail', '200', id], { cwd: location(repo), env, maxBuffer: 2 * 1024 * 1024 });
        return send(res, 200, { output: `${output.stdout || ''}${output.stderr || ''}` });
      }
      if (action === 'processes') return send(res, 200, { output: await dockerOutput(repo, ['top', id]) });
      if (action === 'console') {
        if (matched[0].state !== 'running') return send(res, 409, { error: 'Start the container before opening a console' });
        if (!auth.authorizeAction(res, currentSession, sessionHash, input.authCode)) return;
        return send(res, 200, { ticket: consoles.issue({ sessionHash, repo, container: matched[0], root: !!input.root }) });
      }
      if (['stop', 'kill', 'restart', 'pause'].includes(action) && !auth.authorizeAction(res, currentSession, sessionHash, input.authCode)) return;
      append(repo, `Container ${id}: ${action} requested. Watcher remains ${repo.watching ? 'enabled' : 'paused'}.\n`);
      await dockerOutput(repo, [action === 'resume' ? 'unpause' : action, id]);
      append(repo, `Container ${id}: ${action} completed.\n`);
      return send(res, 200, { ok: true });
    } catch (error) {
      console.error('Container operation failed:', error.message);
      if (action && !['inspect', 'logs', 'processes'].includes(action)) append(repo, `Container ${action} failed. See the management dialog for details.\n`);
      return send(res, 500, { error: `Container operation failed: ${error.message}` });
    } finally {
      active.delete(repo.id);
    }
  };
}

module.exports = { createContainerRoutes };
