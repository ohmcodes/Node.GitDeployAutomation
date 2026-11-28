'use strict';

const { createContainerRoutes } = require('./container-routes');
const { createRepositoryRoutes } = require('./repository-routes');

function createRouter(services) {
  const { repos, getActivity, metrics, auth, send } = services;
  const containerRoute = createContainerRoutes(services);
  const repositoryRoute = createRepositoryRoutes(services);
  return async function route(req, res, pathname) {
    try {
      if (pathname === '/api/auth/mode' && req.method === 'GET') return auth.mode(res);
      if (pathname === '/api/login' && req.method === 'POST') return await auth.login(req, res);
      const authenticated = auth.authenticate(req, res);
      if (!authenticated) return;
      const { sessionHash } = authenticated;
      if (pathname === '/api/logout' && req.method === 'POST') {
        auth.logout(sessionHash);
        return send(res, 200, { ok: true });
      }
      if (pathname === '/api/repos' && req.method === 'GET') return send(res, 200, repos);
      if (pathname === '/api/activity' && req.method === 'GET') return send(res, 200, getActivity());
      if (pathname === '/api/metrics' && req.method === 'GET') return send(res, 200, await metrics());
      const containerMatch = pathname.match(/^\/api\/repos\/([0-9a-f-]{36})\/containers(?:\/([a-f0-9]{12,64})\/(inspect|logs|processes|start|stop|kill|restart|pause|resume|console))?$/i);
      if (containerMatch) return await containerRoute(req, res, containerMatch, authenticated);
      return await repositoryRoute(req, res, pathname, authenticated);
    } catch (error) {
      if (error instanceof SyntaxError || error.message === 'Request too large' || error.message === 'Invalid request') return send(res, 400, { error: error.message });
      console.error(error);
      return send(res, 500, { error: 'Internal server error' });
    }
  };
}

module.exports = { createRouter };
