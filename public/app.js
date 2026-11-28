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
// Per-repository live activity logs. The elements are kept across renders so scroll
// position, text selection and open/closed state survive the 1-3 second refresh.
const logViews = new Map();
// Logs to open on the next render, after the user starts Deploy, Pull or Retry clone.
const openLogNext = new Set();
const BUSY = ['cloning', 'pulling', 'deploying', 'rebuilding', 'checking', 'removing'];

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
  if (['cloning', 'pulling', 'deploying', 'rebuilding', 'checking', 'removing', 'awaiting-key'].includes(repo.status)) return;
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

function repoLog(repo) {
  let view = logViews.get(repo.id);
  if (!view) {
    const box = document.createElement('details');
    box.className = 'repo-log';
    const summary = element('summary', 'repo-log-summary');
    const pre = element('pre', 'repo-log-content');
    pre.tabIndex = 0;
    box.append(summary, pre);
    view = { box, summary, pre, busy: false, stick: true, top: 0 };
    const current = view;
    // Follow new output while the reader is at the bottom; keep their place if they scrolled up.
    pre.addEventListener('scroll', () => {
      if (!pre.isConnected || !pre.clientHeight) return;
      current.stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
      current.top = pre.scrollTop;
    });
    box.addEventListener('toggle', () => { if (box.open) { current.stick = true; pre.scrollTop = pre.scrollHeight; } });
    logViews.set(repo.id, view);
  }
  const busy = BUSY.includes(repo.status);
  // Open the log as soon as an operation starts, so deploy output is visible right away.
  if ((busy && !view.busy) || openLogNext.delete(repo.id)) {
    view.box.open = true;
    view.stick = true;
  }
  view.busy = busy;
  view.summary.replaceChildren(
    ...(busy ? [element('span', 'pulse')] : []),
    document.createTextNode(busy ? `Activity · live (${repo.status})` : 'Activity')
  );
  const text = repo.log || 'No activity yet.';
  const old = view.text || '';
  if (text !== old) {
    // Append only the new part when possible: replacing the whole text clears any selection.
    if (old && text.startsWith(old)) view.pre.append(text.slice(old.length));
    else view.pre.textContent = text;
    view.text = text;
  }
  return view.box;
}

// Cards are rebuilt on every change, which detaches the log and resets its scroll position.
function restoreLogScroll() {
  for (const view of logViews.values()) {
    if (!view.pre.isConnected || !view.box.open) continue;
    view.pre.scrollTop = view.stick ? view.pre.scrollHeight : view.top;
  }
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
    if (method === 'POST' && ['/deploy', '/pull', '/clone'].includes(suffix)) {
      // Show the card and its live log straight away, even if the operation already finished.
      expandedRepos.add(repo.id);
      preferences.expandedRepos = [...expandedRepos];
      saveDisplay();
      openLogNext.add(repo.id);
      repoSnapshot = null;
    }
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
    const busy = BUSY.includes(repo.status);
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
      if (!details.hidden) restoreLogScroll();
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
      action('Settings', 'secondary', () => { selected = repo; $('#settings-error').textContent = ''; $('#edit-script').value = repo.script; $('#edit-owner').value = repo.fileOwner || ''; $('#edit-owner-paths').value = (repo.fileOwnerPaths || []).join(', '); $('#edit-username').value = ''; $('#edit-token').value = ''; $('#edit-token-fields').hidden = repo.authType !== 'token'; $('#settings-dialog').showModal(); }, busy),
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
    const pullButton = action('Pull', 'secondary', () => change(repo, 'POST', undefined, '/pull'), busy || repo.status === 'awaiting-key' || repo.cloneFailed);
    pullButton.title = 'Fetch the latest commits with git pull --ff-only. Does not rebuild or restart containers.';
    pullButton.dataset.repoAction = `${repo.id}:pull`;
    buttons.append(pullButton, deployButton, more);
    details.append(info, buttons, repoLog(repo));
    card.append(header, details);
    list.append(card);
    if (focusedToggle === repo.id) toggle.focus();
    if (focusedAction) {
      const previousFocus = Array.from(card.querySelectorAll('[data-repo-action]')).find(item => item.dataset.repoAction === focusedAction);
      if (previousFocus && !previousFocus.disabled) previousFocus.focus();
    }
  }
  restoreLogScroll();
  renderRepoMetrics();
}

async function refresh(withActivity = true) {
  if (!token || refreshing) return;
  refreshing = true;
  const currentSession = session;
  try {
    const result = await api('/api/repos');
    if (session !== currentSession) return;
    // Log text changes every second during a deploy; keep it out of the snapshot so cards are
    // rebuilt only for real changes, and update the logs in place otherwise.
    const snapshot = JSON.stringify(result.map(({ log, ...rest }) => rest));
    const recentExpired = result.some(repo => repo.lastPulled && Date.parse(repo.lastPulled) + 60000 > renderedAt && Date.parse(repo.lastPulled) + 60000 <= Date.now());
    repos = result;
    const repoIds = new Set(repos.map(repo => repo.id));
    for (const id of expandedRepos) if (!repoIds.has(id)) expandedRepos.delete(id);
    preferences.expandedRepos = [...expandedRepos];
    for (const id of openRepoMenus) if (!repoIds.has(id)) openRepoMenus.delete(id);
    for (const id of repoIcons.keys()) if (!repoIds.has(id)) repoIcons.delete(id);
    for (const id of logViews.keys()) if (!repoIds.has(id)) logViews.delete(id);
    if (snapshot !== repoSnapshot || recentExpired) render();
    else {
      for (const repo of repos) if (logViews.has(repo.id)) repoLog(repo);
      restoreLogScroll();
    }
    repoSnapshot = snapshot;
    if (page === 'activity' && withActivity) {
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
  logViews.clear();
  openLogNext.clear();
  if ($('#env-dialog').open) $('#env-dialog').close();
  if ($('#page-dialog').open) $('#page-dialog').close();
  if ($('#containers-dialog').open) $('#containers-dialog').close();
  if ($('#action-auth-dialog').open) $('#action-auth-dialog').close();
  for (const id of ['console-dialog', 'add-dialog', 'settings-dialog', 'key-dialog', 'delete-dialog']) {
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
    const saved = await api(`/api/repos/${repoId}/env`, { method: 'PUT', body: { content: $('#env-content').value } });
    if (session !== currentSession || requestId !== envRequest || !$('#env-dialog').open) return;
    $('#env-dialog').close();
    notice(saved.warning || 'Environment file saved. Deploy the repository to apply changes.');
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
    const repo = await api('/api/repos', { method: 'POST', body: { url: $('#url').value, branch: $('#branch').value, script: $('#new-script').value, fileOwner: $('#new-owner').value.trim(), fileOwnerPaths: ownerPaths($('#new-owner-paths').value), auth } });
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
function ownerPaths(value) {
  return value.split(',').map(item => item.trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean);
}
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const username = $('#edit-username').value;
  const password = $('#edit-token').value;
  if ((username && !password) || (!username && password)) {
    $('#settings-error').textContent = 'Enter both the username and token to rotate credentials.';
    return;
  }
  const settings = { script: $('#edit-script').value, fileOwner: $('#edit-owner').value.trim(), fileOwnerPaths: ownerPaths($('#edit-owner-paths').value) };
  const repo = selected;
  const ownerChanged = settings.fileOwner !== (repo.fileOwner || '') || settings.fileOwnerPaths.join(',') !== (repo.fileOwnerPaths || []).join(',');
  const scriptChanged = settings.script !== (repo.script || '');
  if (ownerChanged || scriptChanged) {
    const currentSession = session;
    $('#settings-dialog').close();
    const what = [scriptChanged && 'the custom script', ownerChanged && 'file ownership'].filter(Boolean).join(' and ');
    const authCode = await confirmWithAuthenticator(`Change ${what} for ${repo.url}. It applies to every later deployment, including automatic ones.`);
    if (!authCode || session !== currentSession) return;
    settings.authCode = authCode;
  }
  if (username && password) settings.auth = { type: 'token', username, token: password };
  $('#settings-dialog').close();
  $('#edit-token').value = '';
  await change(repo, 'PATCH', settings);
});
if (!token) { $('#login-dialog').showModal(); void loadLoginMode(); }
else { void loadLoginMode(); refresh(); refreshMetrics(); }
// Poll every second while something is running (live logs), otherwise every 3 seconds.
let refreshTick = 0;
setInterval(() => {
  if (document.hidden) return;
  refreshTick++;
  const slowTick = refreshTick % 3 === 0;
  if (slowTick || repos.some(repo => BUSY.includes(repo.status))) void refresh(slowTick);
}, 1000);
setInterval(refreshMetrics, 15000);
