'use strict';

function validUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return ['https:', 'ssh:'].includes(url.protocol) && !!url.hostname &&
      !url.password && (url.protocol === 'ssh:' || !url.username) &&
      !url.search && !url.hash && url.pathname.length > 1;
  } catch {
    return false;
  }
}

function validBranch(value) {
  return typeof value === 'string' && value.length <= 200 &&
    /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) &&
    !value.includes('..') && !value.includes('//') &&
    !value.endsWith('.') && !value.endsWith('/') &&
    !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'));
}

function validTokenAuth(auth, url) {
  return auth && auth.type === 'token' && new URL(url).protocol === 'https:' &&
    typeof auth.username === 'string' && !!auth.username && auth.username.length <= 200 && !/[:\r\n]/.test(auth.username) &&
    typeof auth.token === 'string' && !!auth.token && auth.token.length <= 4096 && !/[\r\n]/.test(auth.token);
}


module.exports = { validUrl, validBranch, validTokenAuth };
