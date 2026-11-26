'use strict';

const $ = selector => document.querySelector(selector);
let token = sessionStorage.getItem('deployToken') || '';
let repos = [];
let filter = 'all';
let selected = null;
let logRepoId = null;
let keyRepoId = null;
let envRepoId = null;
let envRequest = 0;
let pageRequest = 0;
let page = 'dashboard';
let refreshing = false;
let metricsRefreshing = false;
let session = 0;
let renderedAt = 0;
let repoSnapshot = null;
let metricsData = null;
let metricsError = '';

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
    const info = element('div', 'repo-info');
    const name = repo.url.replace(/\/$/, '').split('/').pop().replace(/\.git$/, '');
    const title = element('div', 'repo-title');
    title.append(element('h3', '', name), element('span', `badge ${repo.status}`, repo.status));
    const link = element('a', 'repo-url', repo.url);
    const parsedUrl = new URL(repo.url);
    link.href = parsedUrl.protocol === 'ssh:' ? `https://${parsedUrl.hostname}${parsedUrl.pathname}` : parsedUrl.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    info.append(title, link, element('p', 'repo-meta', `⑂ ${repo.branch}  ·  ${repo.watching ? 'Watching enabled' : 'Watching paused'}  ·  ${repo.lastDeployed ? `Deployed ${new Date(repo.lastDeployed).toLocaleString()}` : 'Not deployed yet'}`));
    if (repo.message) info.append(element('p', 'error', repo.message));
    const micro = element('div', 'repo-metrics');
    micro.dataset.repoId = repo.id;
    info.append(micro);
    const buttons = element('div', 'actions');
    buttons.append(
      action('Activity', 'secondary', () => { logRepoId = repo.id; $('#log-title').textContent = name; updateLog($('#log-content'), repo.log || 'No activity yet.', true); $('#log-dialog').showModal(); $('#log-content').scrollTop = $('#log-content').scrollHeight; }),
      action('Settings', 'secondary', () => { selected = repo; $('#settings-error').textContent = ''; $('#edit-script').value = repo.script; $('#edit-username').value = ''; $('#edit-token').value = ''; $('#edit-token-fields').hidden = repo.authType !== 'token'; $('#settings-dialog').showModal(); }, busy),
      action('.env', 'secondary', () => showEnv(repo, name), busy || repo.status === 'awaiting-key' || repo.cloneFailed),
      action(repo.watching ? 'Pause' : 'Watch', 'secondary', () => change(repo, 'PATCH', { watching: !repo.watching }), busy),
      ...(repo.authType === 'ssh' ? [action('SSH key', 'secondary', () => showKey(repo), busy)] : []),
      ...(repo.cloneFailed ? [action('Retry clone', 'secondary', () => change(repo, 'POST', undefined, '/clone'), busy)] : []),
      ...(repo.lastDeployed ? [action('View page ↗', 'secondary', () => showProjectPage(repo, name), busy)] : []),
      action(repo.lastDeployed ? 'Redeploy ↗' : 'Deploy ↗', 'deploy', () => change(repo, 'POST', undefined, '/deploy'), busy || repo.status === 'awaiting-key' || repo.cloneFailed),
      action('×', 'remove', () => { selected = repo; $('#delete-title').textContent = `Remove ${name}?`; $('#delete-form').reset(); $('#delete-images').disabled = true; $('#delete-dialog').showModal(); }, busy)
    );
    buttons.lastChild.setAttribute('aria-label', `Remove ${name}`);
    card.append(icon, info, buttons);
    list.append(card);
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
      token = '';
      sessionStorage.removeItem('deployToken');
      $('#login-error').textContent = 'Invalid token. Please try again.';
      if (!$('#login-dialog').open) $('#login-dialog').showModal();
    } else notice(`Could not refresh: ${error.message}`);
  } finally {
    refreshing = false;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'Unavailable';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${bytes.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function percent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : 'Sampling…';
}

function containerPercent(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?%$/.test(value.trim())) return null;
  return Number.parseFloat(value);
}

function metricBar(label, value, caption, max = 100) {
  const row = element('div', 'metric-row');
  const heading = element('div', 'metric-row-heading');
  heading.append(element('span', '', label), element('strong', '', caption));
  row.append(heading);
  if (Number.isFinite(value)) {
    const bar = element('div', 'meter');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', label);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(max));
    bar.setAttribute('aria-valuenow', String(Math.max(0, Math.min(max, value))));
    bar.setAttribute('aria-valuetext', caption);
    const fill = element('span', 'meter-fill');
    fill.style.width = `${Math.max(0, Math.min(100, value / max * 100))}%`;
    bar.append(fill);
    row.append(bar);
  }
  return row;
}

function renderRepoMetrics() {
  document.querySelectorAll('.repo-metrics').forEach(node => {
    node.replaceChildren();
    if (metricsError) {
      node.textContent = `Metrics unavailable: ${metricsError}`;
      return;
    }
    if (!metricsData) {
      node.textContent = 'Loading container metrics…';
      return;
    }
    const containers = metricsData.containers.filter(item => item.repoId === node.dataset.repoId);
    if (!containers.length) {
      const repo = repos.find(item => item.id === node.dataset.repoId);
      node.textContent = repo && !repo.lastDeployed && !repo.composeAttempted ? 'Container metrics available after a deployment attempt.' : 'No running managed containers reported.';
      return;
    }
    for (const container of containers) {
      node.append(element('div', 'micro-row', container.error || `${container.name} · CPU ${container.cpu || 'unavailable'} · Memory ${container.memory || 'unavailable'} (${container.memoryPercent || 'unavailable'}) · Network ${container.network || 'unavailable'} · Disk I/O ${container.block || 'unavailable'}`));
    }
  });
}

function renderMetrics() {
  const summary = $('#metrics-summary');
  const detail = $('#metrics-detail');
  const focusedSummary = Array.from(summary.querySelectorAll('.summary-card')).indexOf(document.activeElement);
  summary.replaceChildren();
  detail.replaceChildren();
  if (metricsError || !metricsData) {
    const message = metricsError ? `Metrics unavailable: ${metricsError}` : 'Loading metrics…';
    summary.textContent = message;
    detail.textContent = message;
    renderRepoMetrics();
    return;
  }
  const { runtime, host, containers } = metricsData;
  const runtimeCard = action('', 'summary-card', () => showPage('metrics'));
  runtimeCard.append(element('span', 'summary-label', 'GIT DEPLOY PROCESS'), element('strong', '', `CPU ${percent(runtime.cpuPercent)}`), element('small', '', `${formatBytes(runtime.rss)} memory · ${Math.floor(runtime.uptime / 60)} min uptime`));
  const hostCard = action('', 'summary-card', () => showPage('metrics'));
  hostCard.append(element('span', 'summary-label', 'DOCKER HOST'), element('strong', '', host.error ? 'Unavailable' : `CPU ${percent(host.cpuPercent)}`), element('small', '', host.error || `${formatBytes(host.memoryUsed)} / ${formatBytes(host.memoryTotal)} memory`));
  summary.append(runtimeCard, hostCard);
  if (focusedSummary >= 0) summary.querySelectorAll('.summary-card')[focusedSummary].focus();

  const grid = element('div', 'metric-grid');
  const processPanel = element('section', 'metric-panel');
  processPanel.append(element('h2', '', 'Git Deploy process'), element('p', 'metric-note', 'CPU is relative to one core; values can exceed 100%.'));
  processPanel.append(metricBar('CPU · one core', runtime.cpuPercent, percent(runtime.cpuPercent), Math.max(100, runtime.cpuPercent || 0)));
  processPanel.append(element('p', 'metric-detail-line', `Resident memory: ${formatBytes(runtime.rss)} · Heap used: ${formatBytes(runtime.heapUsed)}`), element('p', 'metric-detail-line', `Uptime: ${Math.floor(runtime.uptime / 60)} min · Platform: ${runtime.platform}`));
  const hostPanel = element('section', 'metric-panel');
  hostPanel.append(element('h2', '', 'Docker host'), element('p', 'metric-note', 'CPU and memory of the configured host, not necessarily your desktop.'));
  if (host.error) hostPanel.append(element('p', 'metric-unavailable', host.error));
  else {
    const memoryPercent = host.memoryTotal > 0 ? 100 * host.memoryUsed / host.memoryTotal : null;
    hostPanel.append(metricBar('CPU', host.cpuPercent, percent(host.cpuPercent)), metricBar('Memory', memoryPercent, `${formatBytes(host.memoryUsed)} / ${formatBytes(host.memoryTotal)}${memoryPercent === null ? '' : ` · ${percent(memoryPercent)}`}`));
  }
  grid.append(processPanel, hostPanel);
  detail.append(grid);
  const containerSection = element('section', 'container-section');
  containerSection.append(element('h2', '', 'Managed containers'), element('p', 'metric-note', 'Running containers reported by managed Compose projects. CPU is relative to one core and may exceed 100%.'));
  if (!containers.length) containerSection.append(element('p', 'metric-unavailable', 'No running managed containers reported.'));
  for (const container of containers) {
    const repo = repos.find(item => item.id === container.repoId);
    const panel = element('article', 'metric-panel container-panel');
    panel.append(element('h3', '', container.name || 'Container metrics unavailable'), element('p', 'metric-note', repo ? repo.url : `Repository ${container.repoId}`));
    if (container.error) panel.append(element('p', 'metric-unavailable', container.error));
    else {
      const cpu = containerPercent(container.cpu);
      const memory = containerPercent(container.memoryPercent);
      panel.append(metricBar('CPU · one core', cpu, container.cpu || 'Unavailable', Math.max(100, cpu || 0)));
      panel.append(metricBar('Memory', memory, `${container.memory || 'Unavailable'}${container.memoryPercent ? ` · ${container.memoryPercent}` : ''}`));
      panel.append(element('p', 'metric-detail-line', `Network I/O: ${container.network || 'Unavailable'} · Block I/O: ${container.block || 'Unavailable'}`));
    }
    containerSection.append(panel);
  }
  detail.append(containerSection);
  renderRepoMetrics();
}

async function refreshMetrics() {
  if (!token || metricsRefreshing) return;
  metricsRefreshing = true;
  const currentSession = session;
  try {
    const data = await api('/api/metrics');
    if (session !== currentSession) return;
    metricsData = data;
    metricsError = '';
    renderMetrics();
  } catch (error) {
    if (session === currentSession) {
      metricsData = null;
      metricsError = error.message;
      renderMetrics();
    }
  } finally {
    metricsRefreshing = false;
  }
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  token = $('#token').value;
  const success = await refresh();
  if (success) {
    sessionStorage.setItem('deployToken', token);
    $('#login-dialog').close();
    $('#token').value = '';
    refreshMetrics();
  } else if (token) $('#login-error').textContent = 'Could not connect to the server. Please try again.';
});
$('#logout').addEventListener('click', () => {
  session++;
  token = '';
  sessionStorage.removeItem('deployToken');
  repos = [];
  repoSnapshot = null;
  metricsData = null;
  metricsError = '';
  renderMetrics();
  $('#feed-content').textContent = 'No activity yet.';
  $('#log-content').textContent = '';
  if ($('#env-dialog').open) $('#env-dialog').close();
  if ($('#page-dialog').open) $('#page-dialog').close();
  render();
  $('#login-dialog').showModal();
});
$('#login-dialog').addEventListener('cancel', event => event.preventDefault());
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
  document.querySelectorAll('.filter').forEach(item => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  render();
}));
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
  $('#delete-dialog').close();
  await change(selected, 'DELETE', { containers: $('#delete-containers').checked, images: $('#delete-images').checked });
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
if (!token) $('#login-dialog').showModal();
else { refresh(); refreshMetrics(); }
setInterval(refresh, 3000);
setInterval(refreshMetrics, 15000);
