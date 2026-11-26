'use strict';

import { createMetricsScreen } from './metrics.js';
import { createContainerScreen } from './containers.js';
import { loadPreferences, savePreferences } from './preferences.js';

const $ = selector => document.querySelector(selector);
const preferences = loadPreferences();
const saveDisplay = () => savePreferences(preferences);
sessionStorage.removeItem('deployToken');
let token = sessionStorage.getItem('deploySession') || '';
let repos = [];
let filter = preferences.filter;
let selected = null;
let logRepoId = null;
let keyRepoId = null;
let envRepoId = null;
let envRequest = 0;
let pageRequest = 0;
let page = 'dashboard';
let refreshing = false;
let session = 0;
let renderedAt = 0;
let repoSnapshot = null;
let actionAuthResolve = null;
let loginMethod = null;
const expandedRepos = new Set(preferences.expandedRepos);
const openRepoMenus = new Set();
const repoIcons = new Map();

function showRepoIcon(icon, repo) {
  const cached = repoIcons.get(repo.id);
  const version = `${repo.commit || ''}:${repo.lastPulled || ''}:${repo.cloneFailed || false}`;
  if (cached && cached.version === version) {
    if (cached.icon) {
      const image = element('img', 'repo-icon-image');
      image.alt = '';
      image.src = cached.icon;
      image.addEventListener('error', () => {
        console.warn(`Could not display icon for repository ${repo.id}`);
        icon.textContent = '⌘';
      });
      icon.replaceChildren(image);
    }
    return;
  }
  if (['cloning', 'deploying', 'rebuilding', 'checking', 'removing', 'awaiting-key'].includes(repo.status)) return;
  const entry = { version, icon: null };
  repoIcons.set(repo.id, entry);
  const currentSession = session;
  api(`/api/repos/${repo.id}/icon`).then(result => {
    if (session !== currentSession || repoIcons.get(repo.id) !== entry) return;
    if (result.icon !== null && (typeof result.icon !== 'string' || !/^data:image\/(?:png|x-icon|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(result.icon))) {
      throw new Error('Invalid repository icon response');
    }
    entry.icon = result.icon;
    for (const current of document.querySelectorAll('.repo-icon[data-repo-id]')) {
      if (current.dataset.repoId === repo.id) showRepoIcon(current, repo);
    }
  }).catch(error => {
    if (session !== currentSession || repoIcons.get(repo.id) !== entry) return;
    repoIcons.delete(repo.id);
    icon.title = 'Repository icon unavailable';
    console.warn(`Unable to load icon for repository ${repo.id}:`, error);
  });
}

function confirmWithAuthenticator(description) {
  if (loginMethod === 'token') {
    notice('Set up an authenticator on the deployment host before performing this action.');
    return Promise.resolve(null);
  }
  if (actionAuthResolve) return Promise.resolve(null);
  $('#action-auth-description').textContent = description;
  $('#action-auth-code').value = '';
  $('#action-auth-dialog').showModal();
  return new Promise(resolve => { actionAuthResolve = resolve; });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: ['Bearer', token].join(' '), 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function notice(message) {
  $('#notice').textContent = message;
}

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function action(label, className, handler, disabled) {
  const button = element('button', className, label);
  button.type = 'button';
  button.disabled = disabled;
  button.addEventListener('click', handler);
  return button;
}

function updateLog(node, value, auto) {
  if (node.textContent === value) return;
  const top = node.scrollTop;
  node.textContent = value;
  node.scrollTop = auto ? node.scrollHeight : top;
}

function showKey(repo) {
  keyRepoId = repo.id;
  $('#public-key').textContent = repo.publicKey;
  $('#clone-key').hidden = repo.status !== 'awaiting-key' && !repo.cloneFailed;
  $('#key-dialog').showModal();
}

async function showEnv(repo, name) {
  const requestId = ++envRequest;
  const currentSession = session;
  envRepoId = repo.id;
  $('#env-title').textContent = name;
  $('#env-content').value = '';
  $('#env-content').disabled = true;
  $('#env-save').disabled = true;
  $('#env-error').textContent = '';
  $('#env-status').textContent = 'Loading environment file…';
  $('#env-dialog').showModal();
  try {
    const result = await api(`/api/repos/${repo.id}/env`);
    if (session !== currentSession || requestId !== envRequest || !$('#env-dialog').open) return;
    $('#env-content').value = result.content;
    $('#env-content').disabled = result.tracked;
    $('#env-save').disabled = result.tracked;
    $('#env-status').textContent = result.tracked
      ? 'This .env is tracked by Git and cannot be changed here. Remove it from version control before storing secrets.'
      : result.exists ? 'Existing .env loaded. Saving replaces its contents.' : 'No .env exists yet. Saving creates one.';
  } catch (error) {
    if (session === currentSession && requestId === envRequest && $('#env-dialog').open) {
      $('#env-status').textContent = '';
      $('#env-error').textContent = error.message;
    }
  }
}

async function showProjectPage(repo, name) {
  const requestId = ++pageRequest;
  const currentSession = session;
  const links = $('#page-links');
  $('#page-title').textContent = name;
  links.textContent = 'Finding project page…';
  $('#page-dialog').showModal();
  try {
    const result = await api(`/api/repos/${repo.id}/page`);
    if (session !== currentSession || requestId !== pageRequest || !$('#page-dialog').open) return;
    links.replaceChildren();
    if (result.url) {
      const link = element('a', 'page-link', result.url);
      link.href = result.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      links.append(element('p', '', 'From the repository DOMAIN:'), link);
    } else if (result.ports.length) {
      links.append(element('p', '', 'Choose a published TCP port:'));
      for (const published of result.ports) {
        const url = new URL(window.location.origin);
        url.protocol = 'http:';
        url.port = String(published.port);
        url.pathname = '/';
        url.search = '';
        url.hash = '';
        const label = `${published.service || 'Service'} · ${url.href} · bound to ${published.hostIp || 'unspecified address'}`;
        const link = element('a', 'page-link', label);
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        links.append(link);
      }
    } else {
      links.textContent = 'No DOMAIN or published TCP ports found. Add DOMAIN to the repository .env or publish a web port in Compose.';
    }
  } catch (error) {
    if (session === currentSession && requestId === pageRequest && $('#page-dialog').open) links.textContent = error.message;
  }
}

async function change(repo, method, body, suffix = '') {
  try {
    if (method === 'POST' && suffix === '/deploy') {
      const currentSession = session;
      const authCode = await confirmWithAuthenticator(`${repo.lastDeployed ? 'Redeploy' : 'Deploy'} ${repo.url}. Services may be recreated and repository scripts may run.`);
      if (!authCode || session !== currentSession) return;
      body = { ...body, authCode };
    }
    await api(`/api/repos/${repo.id}${suffix}`, { method, body });
    notice('');
    await refresh();
  } catch (error) {
    notice(error.message);
  }
}

function render() {
  renderedAt = Date.now();
  $('#total').textContent = repos.length;
  $('#watching').textContent = repos.filter(repo => repo.watching).length;
  $('#deployed').textContent = repos.filter(repo => repo.lastDeployed).length;
  $('#errors').textContent = repos.filter(repo => repo.status === 'error').length;
  const shown = repos.filter(repo => filter === 'all' || (filter === 'watching' ? repo.watching : filter === 'deployed' ? repo.lastDeployed : repo.status === 'error'));
  const list = $('#repos');
  const focusedToggle = list.contains(document.activeElement) && document.activeElement.dataset.repoToggle;
  const focusedAction = list.contains(document.activeElement) && document.activeElement.dataset.repoAction;
  list.replaceChildren();
  if (!shown.length) {
    const empty = element('div', 'empty');
    empty.append(element('div', 'empty-icon', '◇'), element('h3', '', 'Nothing here yet'), element('p', '', filter === 'all' ? 'Add a repository to start deploying with less effort.' : 'No repositories match this view.'));
    list.append(empty);
    return;
  }
  for (const repo of shown) {
    const busy = ['cloning', 'deploying', 'rebuilding', 'checking', 'removing'].includes(repo.status);
    const recent = repo.lastPulled && Date.now() - Date.parse(repo.lastPulled) < 60000;
    const card = element('article', `repo${repo.status === 'error' ? ' is-error' : repo.status === 'rebuilding' ? ' is-rebuilding' : !repo.watching ? ' is-paused' : recent ? ' is-recent' : ''}`);
    const icon = element('div', 'repo-icon', '⌘');
    icon.dataset.repoId = repo.id;
    showRepoIcon(icon, repo);
    const info = element('div', 'repo-info');
    const name = repo.url.replace(/\/$/, '').split('/').pop().replace(/\.git$/, '');
    const title = element('div', 'repo-title');
    title.append(element('h3', '', name), element('span', `badge ${repo.status}`, repo.status));
    const header = element('div', 'repo-header');
    const summary = element('div', 'repo-summary');
    summary.append(title, element('p', 'repo-meta', `⑂ ${repo.branch}  ·  ${repo.watching ? 'Watching enabled' : 'Watching paused'}`));
    const micro = element('div', 'repo-metrics');
    micro.dataset.repoId = repo.id;
    summary.append(micro);
    const details = element('div', 'repo-details');
    details.id = `repo-details-${repo.id}`;
    details.hidden = !expandedRepos.has(repo.id);
    const toggle = action('', 'secondary repo-toggle', () => {
      details.hidden = !details.hidden;
      if (details.hidden) expandedRepos.delete(repo.id);
      else expandedRepos.add(repo.id);
      preferences.expandedRepos = [...expandedRepos];
      saveDisplay();
      updateToggle();
    });
    toggle.dataset.repoToggle = repo.id;
    toggle.setAttribute('aria-controls', details.id);
    function updateToggle() {
      toggle.textContent = details.hidden ? 'Expand' : 'Collapse';
      toggle.setAttribute('aria-expanded', String(!details.hidden));
      toggle.setAttribute('aria-label', `${details.hidden ? 'Expand' : 'Collapse'} ${name}`);
    }
    updateToggle();
    header.append(icon, summary, toggle);
    const link = element('a', 'repo-url', repo.url);
    const parsedUrl = new URL(repo.url);
    link.href = parsedUrl.protocol === 'ssh:' ? `https://${parsedUrl.hostname}${parsedUrl.pathname}` : parsedUrl.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    info.append(link, element('p', 'repo-meta', repo.lastDeployed ? `Deployed ${new Date(repo.lastDeployed).toLocaleString()}` : 'Not deployed yet'));
    if (repo.message) info.append(element('p', 'error', repo.message));
    const buttons = element('div', 'repo-actions');
    const more = document.createElement('details');
    more.className = 'repo-more';
    more.open = openRepoMenus.has(repo.id);
    const moreSummary = element('summary', 'secondary', 'More actions');
    moreSummary.dataset.repoAction = `${repo.id}:menu`;
    more.append(moreSummary);
    more.addEventListener('toggle', () => {
      if (!more.isConnected) return;
      if (more.open) openRepoMenus.add(repo.id);
      else openRepoMenus.delete(repo.id);
    });
    const extra = element('div', 'repo-more-list');
    extra.append(
      action('Activity', 'secondary', () => { logRepoId = repo.id; $('#log-title').textContent = name; updateLog($('#log-content'), repo.log || 'No activity yet.', true); $('#log-dialog').showModal(); $('#log-content').scrollTop = $('#log-content').scrollHeight; }),
      action('Settings', 'secondary', () => { selected = repo; $('#settings-error').textContent = ''; $('#edit-script').value = repo.script; $('#edit-username').value = ''; $('#edit-token').value = ''; $('#edit-token-fields').hidden = repo.authType !== 'token'; $('#settings-dialog').showModal(); }, busy),
      action('.env', 'secondary', () => showEnv(repo, name), busy || repo.status === 'awaiting-key' || repo.cloneFailed),
      action(repo.watching ? 'Pause' : 'Watch', 'secondary', () => change(repo, 'PATCH', { watching: !repo.watching }), busy),
      ...(repo.authType === 'ssh' ? [action('SSH key', 'secondary', () => showKey(repo), busy)] : []),
      ...(repo.cloneFailed ? [action('Retry clone', 'secondary', () => change(repo, 'POST', undefined, '/clone'), busy)] : []),
      ...(repo.lastDeployed ? [action('View page ↗', 'secondary', () => showProjectPage(repo, name), busy)] : []),
      ...(repo.lastDeployed || repo.composeAttempted ? [action('Containers', 'secondary', () => openContainers(repo, name), busy)] : []),
      action('Remove', 'secondary repo-remove', () => { selected = repo; $('#delete-title').textContent = `Remove ${name}?`; $('#delete-form').reset(); $('#delete-images').disabled = true; $('#delete-dialog').showModal(); }, busy)
    );
    extra.lastChild.setAttribute('aria-label', `Remove ${name}`);
    for (const button of extra.querySelectorAll('button')) button.dataset.repoAction = `${repo.id}:${button.textContent}`;
    more.append(extra);
    more.addEventListener('click', event => {
      if (event.target.closest('button')) more.open = false;
    });
    const deployButton = action(repo.lastDeployed ? 'Redeploy ↗' : 'Deploy ↗', 'deploy', () => change(repo, 'POST', undefined, '/deploy'), busy || repo.status === 'awaiting-key' || repo.cloneFailed);
    deployButton.dataset.repoAction = `${repo.id}:deploy`;
    buttons.append(deployButton, more);
    details.append(info, buttons);
    card.append(header, details);
    list.append(card);
    if (focusedToggle === repo.id) toggle.focus();
    if (focusedAction) {
      const previousFocus = Array.from(card.querySelectorAll('[data-repo-action]')).find(item => item.dataset.repoAction === focusedAction);
      if (previousFocus && !previousFocus.disabled) previousFocus.focus();
    }
  }
  renderRepoMetrics();
}

async function refresh() {
  if (!token || refreshing) return;
  refreshing = true;
  const currentSession = session;
  try {
    const result = await api('/api/repos');
    if (session !== currentSession) return;
    const snapshot = JSON.stringify(result);
    const recentExpired = result.some(repo => repo.lastPulled && Date.parse(repo.lastPulled) + 60000 > renderedAt && Date.parse(repo.lastPulled) + 60000 <= Date.now());
    repos = result;
    const repoIds = new Set(repos.map(repo => repo.id));
    for (const id of expandedRepos) if (!repoIds.has(id)) expandedRepos.delete(id);
    preferences.expandedRepos = [...expandedRepos];
    for (const id of openRepoMenus) if (!repoIds.has(id)) openRepoMenus.delete(id);
    for (const id of repoIcons.keys()) if (!repoIds.has(id)) repoIcons.delete(id);
    if (snapshot !== repoSnapshot || recentExpired) render();
    repoSnapshot = snapshot;
    if ($('#log-dialog').open) {
      const current = repos.find(repo => repo.id === logRepoId);
      if (current) updateLog($('#log-content'), current.log || 'No activity yet.', $('#log-autoscroll').checked);
    }
    if (page === 'activity') {
      const entries = await api('/api/activity');
      if (session !== currentSession) return;
      updateLog($('#feed-content'), entries.map(entry => `[${new Date(entry.time).toLocaleString()}] ${entry.url}\n${entry.text}`).join('\n') || 'No activity yet.', $('#feed-autoscroll').checked);
    }
    notice('');
    return true;
  } catch (error) {
    if (session !== currentSession) return;
    if (error.message === 'Unauthorized') {
      clearSession();
      $('#login-error').textContent = 'Session expired. Sign in again.';
    } else notice(`Could not refresh: ${error.message}`);
  } finally {
    refreshing = false;
  }
}

const { openContainers } = createContainerScreen({ $, element, action, api, confirmWithAuthenticator, getSession: () => session });
const { renderRepoMetrics, refreshMetrics, resetMetrics } = createMetricsScreen({
  $, element, action, api, showPage, getRepos: () => repos, getToken: () => token, getSession: () => session,
  preferences, saveDisplay
});

async function loadLoginMode() {
  const submit = $('#login-form button[type=submit]');
  submit.disabled = true;
  loginMethod = null;
  try {
    const result = await api('/api/auth/mode');
    if (!['token', 'authenticator'].includes(result.method)) throw new Error('Unknown sign-in method.');
    loginMethod = result.method;
    const useToken = result.method === 'token';
    $('#login-token-fields').hidden = !useToken;
    $('#login-otp-fields').hidden = useToken;
    $('#token').required = useToken;
    $('#otp').required = !useToken;
    $('#login-description').textContent = useToken ? 'Enter your deployment token.' : 'Enter your authenticator code.';
    $('#login-hint').textContent = useToken
      ? 'Set up an authenticator on the deployment host to enable sensitive actions. Sessions last up to eight hours.'
      : 'Use a fresh code for each sign-in. Sessions last up to eight hours.';
    submit.disabled = false;
  } catch (error) {
    $('#login-error').textContent = `Unable to determine sign-in method: ${error.message}. Reload to retry.`;
  }
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#login-error').textContent = '';
  const submit = $('#login-form button[type=submit]');
  submit.disabled = true;
  try {
    const result = await api('/api/login', { method: 'POST', body: { token: $('#token').value, code: $('#otp').value } });
    token = result.session;
    sessionStorage.setItem('deploySession', token);
    $('#login-dialog').close();
    $('#token').value = '';
    $('#otp').value = '';
    await refresh();
    refreshMetrics();
  } catch (error) {
    $('#login-error').textContent = error.message;
    $('#otp').value = '';
    await loadLoginMode();
  } finally {
    if (loginMethod) submit.disabled = false;
  }
});
function clearSession() {
  session++;
  token = '';
  openRepoMenus.clear();
  repoIcons.clear();
  sessionStorage.removeItem('deploySession');
  repos = [];
  repoSnapshot = null;
  resetMetrics();
  $('#feed-content').textContent = 'No activity yet.';
  $('#log-content').textContent = '';
  if ($('#env-dialog').open) $('#env-dialog').close();
  if ($('#page-dialog').open) $('#page-dialog').close();
  if ($('#containers-dialog').open) $('#containers-dialog').close();
  if ($('#action-auth-dialog').open) $('#action-auth-dialog').close();
  for (const id of ['add-dialog', 'settings-dialog', 'log-dialog', 'key-dialog', 'delete-dialog']) {
    if ($(`#${id}`).open) $(`#${id}`).close();
  }
  $('#edit-token').value = '';
  $('#git-token').value = '';
  $('#token').value = '';
  $('#otp').value = '';
  render();
  if (!$('#login-dialog').open) $('#login-dialog').showModal();
  void loadLoginMode();
}
$('#logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
    clearSession();
    $('#login-error').textContent = '';
  } catch (error) {
    clearSession();
    $('#login-error').textContent = `Local session cleared, but server logout failed: ${error.message}`;
  }
});
$('#login-dialog').addEventListener('cancel', event => event.preventDefault());
$('#action-auth-form').addEventListener('submit', event => {
  event.preventDefault();
  $('#action-auth-dialog').close('confirm');
});
$('#action-auth-cancel').addEventListener('click', () => $('#action-auth-dialog').close());
$('#action-auth-dialog').addEventListener('close', () => {
  const code = $('#action-auth-dialog').returnValue === 'confirm' ? $('#action-auth-code').value : null;
  $('#action-auth-dialog').returnValue = '';
  $('#action-auth-code').value = '';
  const resolve = actionAuthResolve;
  actionAuthResolve = null;
  if (resolve) resolve(code);
});
$('#add-open').addEventListener('click', () => { $('#add-error').textContent = ''; $('#add-dialog').showModal(); });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
$('#env-dialog').addEventListener('close', () => {
  envRequest++;
  envRepoId = null;
  $('#env-content').value = '';
});
$('#page-dialog').addEventListener('close', () => {
  pageRequest++;
  $('#page-links').replaceChildren();
});
$('#env-form').addEventListener('submit', async event => {
  event.preventDefault();
  const repoId = envRepoId;
  const requestId = envRequest;
  const currentSession = session;
  $('#env-save').disabled = true;
  $('#env-error').textContent = '';
  try {
    await api(`/api/repos/${repoId}/env`, { method: 'PUT', body: { content: $('#env-content').value } });
    if (session !== currentSession || requestId !== envRequest || !$('#env-dialog').open) return;
    $('#env-dialog').close();
    notice('Environment file saved. Deploy the repository to apply changes.');
  } catch (error) {
    if (session === currentSession && requestId === envRequest && $('#env-dialog').open) {
      $('#env-error').textContent = error.message;
      $('#env-save').disabled = false;
    }
  }
});
function showPage(nextPage) {
  page = nextPage;
  $('#current-page').textContent = { dashboard: 'REPOSITORIES', metrics: 'SYSTEM METRICS', activity: 'ACTIVITY FEED', help: 'DEVELOPER GUIDE' }[page];
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  for (const name of ['dashboard', 'metrics', 'activity', 'help']) $(`#${name}-page`).hidden = page !== name;
  if (page === 'activity') refresh();
}
document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
document.querySelectorAll('[data-open-metrics]').forEach(button => button.addEventListener('click', () => showPage('metrics')));
document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  preferences.filter = filter;
  saveDisplay();
  document.querySelectorAll('.filter').forEach(item => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  render();
}));
document.querySelectorAll('.filter').forEach(button => {
  const active = button.dataset.filter === filter;
  button.classList.toggle('active', active);
  button.setAttribute('aria-pressed', String(active));
});
document.querySelectorAll('[data-repo-columns]').forEach(button => button.addEventListener('click', () => {
  $('#repos').style.setProperty('--columns', button.dataset.repoColumns);
  preferences.repoColumns = Number(button.dataset.repoColumns);
  saveDisplay();
  document.querySelectorAll('[data-repo-columns]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
}));
$('#repos').style.setProperty('--columns', preferences.repoColumns);
document.querySelectorAll('[data-repo-columns]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.repoColumns) === preferences.repoColumns)));
$('#accent').value = preferences.accent;
document.documentElement.dataset.accent = preferences.accent;
$('#accent').addEventListener('change', () => {
  preferences.accent = $('#accent').value;
  document.documentElement.dataset.accent = preferences.accent;
  saveDisplay();
});
const savedTheme = localStorage.getItem('theme');
$('#theme').value = ['dark', 'futuristic', 'midnight', 'light', 'sand'].includes(savedTheme) ? savedTheme : 'dark';
document.documentElement.dataset.theme = $('#theme').value;
$('#theme').addEventListener('change', () => {
  document.documentElement.dataset.theme = $('#theme').value;
  localStorage.setItem('theme', $('#theme').value);
});
$('#auth-type').addEventListener('change', () => {
  $('#token-fields').hidden = $('#auth-type').value !== 'token';
  $('#ssh-hint').hidden = $('#auth-type').value !== 'ssh';
  $('#git-username').required = $('#auth-type').value === 'token';
  $('#git-token').required = $('#auth-type').value === 'token';
});
$('#delete-containers').addEventListener('change', () => {
  $('#delete-images').disabled = !$('#delete-containers').checked;
  if ($('#delete-images').disabled) $('#delete-images').checked = false;
});
$('#delete-form').addEventListener('submit', async event => {
  event.preventDefault();
  const repo = selected;
  const currentSession = session;
  const options = { containers: $('#delete-containers').checked, images: $('#delete-images').checked };
  const authCode = await confirmWithAuthenticator(`Delete ${repo.url}${options.containers ? ', stop its Compose services' : ''}${options.images ? ', and remove local images' : ''}.`);
  if (!authCode || session !== currentSession || selected !== repo || !$('#delete-dialog').open) return;
  $('#delete-dialog').close();
  await change(repo, 'DELETE', { ...options, authCode });
  refreshMetrics();
});
$('#clone-key').addEventListener('click', async () => {
  const repo = repos.find(item => item.id === keyRepoId);
  if (!repo) return;
  $('#key-dialog').close();
  await change(repo, 'POST', undefined, '/clone');
});
$('#add-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const type = $('#auth-type').value;
    const auth = type === 'token' ? { type, username: $('#git-username').value, token: $('#git-token').value } : { type };
    const repo = await api('/api/repos', { method: 'POST', body: { url: $('#url').value, branch: $('#branch').value, script: $('#new-script').value, auth } });
    $('#add-dialog').close();
    $('#add-form').reset();
    $('#auth-type').dispatchEvent(new Event('change'));
    notice('');
    await refresh();
    if (repo.status === 'awaiting-key') showKey(repo);
  } catch (error) {
    $('#add-error').textContent = error.message;
  }
});
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const username = $('#edit-username').value;
  const password = $('#edit-token').value;
  if ((username && !password) || (!username && password)) {
    $('#settings-error').textContent = 'Enter both the username and token to rotate credentials.';
    return;
  }
  const settings = { script: $('#edit-script').value };
  if (username && password) settings.auth = { type: 'token', username, token: password };
  $('#settings-dialog').close();
  $('#edit-token').value = '';
  await change(selected, 'PATCH', settings);
});
if (!token) { $('#login-dialog').showModal(); void loadLoginMode(); }
else { void loadLoginMode(); refresh(); refreshMetrics(); }
setInterval(refresh, 3000);
setInterval(refreshMetrics, 15000);
