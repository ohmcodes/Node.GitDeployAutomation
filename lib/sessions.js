'use strict';

const crypto = require('node:crypto');
const { verifyCode, readAuth, writeAuth } = require('../auth');

function createSessions({ root, token, send, body }) {
  const sessions = new Map();
  const lifetime = 8 * 60 * 60 * 1000;
  let loginFailures = [];
  let actionFailures = [];

  function mode(res) {
    send(res, 200, { method: readAuth(root) ? 'authenticator' : 'token' });
  }

  async function login(req, res) {
    const now = Date.now();
    loginFailures = loginFailures.filter(time => now - time < 15 * 60 * 1000);
    if (loginFailures.length >= 5) return send(res, 429, { error: 'Too many login attempts. Try again later.' });
    loginFailures.push(now);
    const input = await body(req, 8192);
    const config = readAuth(root);
    let counter = null;
    if (config) {
      counter = verifyCode(config.secret, input.code, config.lastCounter, now);
      if (counter === null) return send(res, 401, { error: 'Invalid or already used authenticator code.' });
    } else {
      const supplied = typeof input.token === 'string' ? input.token : '';
      const expectedHash = crypto.createHash('sha256').update(token).digest();
      const suppliedHash = crypto.createHash('sha256').update(supplied).digest();
      if (!crypto.timingSafeEqual(expectedHash, suppliedHash)) return send(res, 401, { error: 'Invalid deployment token.' });
    }
    for (const [id, item] of sessions) if (item.expires <= now) sessions.delete(id);
    if (sessions.size >= 100) return send(res, 429, { error: 'Too many active sessions. Try again later.' });
    if (config) writeAuth(root, { ...config, lastCounter: counter });
    loginFailures = [];
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const sessionHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
    sessions.set(sessionHash, { expires: now + lifetime, generation: config ? config.generation : null });
    return send(res, 200, { session: sessionToken, expires: now + lifetime });
  }

  function authenticate(req, res) {
    const authorization = req.headers.authorization || '';
    const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const sessionHash = crypto.createHash('sha256').update(supplied).digest('hex');
    const currentSession = sessions.get(sessionHash);
    const config = currentSession ? readAuth(root) : null;
    if (!currentSession || currentSession.expires <= Date.now() ||
        currentSession.generation !== (config ? config.generation : null)) {
      if (currentSession) sessions.delete(sessionHash);
      send(res, 401, { error: 'Unauthorized' });
      return null;
    }
    return { currentSession, sessionHash };
  }

  // For long-lived connections (consoles) that outlive the request that authenticated them.
  function isValid(sessionHash) {
    const currentSession = sessions.get(sessionHash);
    if (!currentSession || currentSession.expires <= Date.now()) return false;
    const config = readAuth(root);
    return currentSession.generation === (config ? config.generation : null);
  }

  function logout(sessionHash) {
    sessions.delete(sessionHash);
  }

  function authorizeAction(res, currentSession, sessionHash, code) {
    const now = Date.now();
    const config = readAuth(root);
    if (sessions.get(sessionHash) !== currentSession || currentSession.expires <= now ||
        currentSession.generation !== (config ? config.generation : null)) {
      send(res, 401, { error: 'Unauthorized' });
      return false;
    }
    if (!config) {
      send(res, 403, { error: 'Set up an authenticator on the deployment host before performing this action.' });
      return false;
    }
    if (typeof code !== 'string' || !code) {
      send(res, 403, { error: 'A fresh authenticator code is required for this action.' });
      return false;
    }
    actionFailures = actionFailures.filter(time => now - time < 15 * 60 * 1000);
    if (actionFailures.length >= 5) {
      send(res, 429, { error: 'Too many authenticator attempts. Try again later.' });
      return false;
    }
    const counter = verifyCode(config.secret, code, config.lastCounter, now);
    if (counter === null) {
      actionFailures.push(now);
      send(res, 403, { error: 'Invalid or already used authenticator code. Wait for a new code and try again.' });
      return false;
    }
    writeAuth(root, { ...config, lastCounter: counter });
    actionFailures = [];
    return true;
  }

  return { mode, login, authenticate, isValid, logout, authorizeAction };
}

module.exports = { createSessions };
