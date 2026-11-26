'use strict';

const $ = selector => document.querySelector(selector);
sessionStorage.removeItem('deployToken');
let token = sessionStorage.getItem('deploySession') || '';
let repos = [];
let filter = 'all';
let selected = null;
let logRepoId = null;
let keyRepoId = null;
let envRepoId = null;
let envRequest = 0;
let pageRequest = 0;
let containerRequest = 0;
let containerRepoId = null;
let page = 'dashboard';
let refreshing = false;
let metricsRefreshing = false;
let session = 0;
let renderedAt = 0;
let repoSnapshot = null;
let metricsData = null;
let metricsError = '';
let actionAuthResolve = null;
const metricHistory = new Map();
const previousIo = new Map();

function confirmWithAuthenticator(description) {
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

async function loadContainers() {
  const requestId = ++containerRequest;
  const currentSession = session;
  const repoId = containerRepoId;
  $('#containers-status').textContent = 'Loading containers…';
  try {
    const containers = await api(`/api/repos/${repoId}/containers`);
    if (session !== currentSession || requestId !== containerRequest || !$('#containers-dialog').open) return;
    const list = $('#container-list');
    list.replaceChildren();
    if (!containers.length) list.append(element('p', 'hint', 'No containers found for this project.'));
    for (const container of containers) {
      const card = element('div', 'container-control');
      card.append(element('strong', '', container.name || container.id), element('p', 'hint', `${container.service || 'Service'} · ${container.status || container.state || 'unknown'}`));
      const buttons = element('div', 'actions');
      for (const [label, command] of [['Details / inspect', 'inspect'], ['Logs', 'logs'], ['Processes', 'processes']]) {
        buttons.append(action(label, 'secondary', () => containerOperation(container, command)));
      }
      for (const command of ['start', 'stop', 'kill', 'restart', 'pause', 'resume']) {
        const valid = command === 'start' ? ['created', 'exited', 'dead'].includes(container.state) :
          command === 'resume' ? container.state === 'paused' :
            command === 'pause' ? container.state === 'running' : ['running', 'paused', 'restarting'].includes(container.state);
        buttons.append(action(command[0].toUpperCase() + command.slice(1), command === 'kill' ? 'remove' : 'secondary', () => containerOperation(container, command), !valid));
      }
      card.append(buttons);
      list.append(card);
    }
    $('#containers-status').textContent = '';
  } catch (error) {
    if (session === currentSession && requestId === containerRequest && $('#containers-dialog').open) $('#containers-status').textContent = error.message;
  }
}

async function containerOperation(container, command) {
  const modifying = !['inspect', 'logs', 'processes'].includes(command);
  if (modifying && !confirm(`${command.toUpperCase()} ${container.name || container.id}? This can interrupt the service. The repository watcher will remain unchanged and may redeploy it.`)) return;
  const repoId = containerRepoId;
  const currentSession = session;
  let authCode;
  if (['stop', 'kill', 'restart', 'pause'].includes(command)) {
    authCode = await confirmWithAuthenticator(`${command.toUpperCase()} ${container.name || container.id}. The service may be interrupted.`);
    if (!authCode || session !== currentSession || containerRepoId !== repoId || !$('#containers-dialog').open) return;
  }
  const requestId = ++containerRequest;
  $('#containers-status').textContent = `${command} in progress…`;
  try {
    const result = await api(`/api/repos/${repoId}/containers/${container.id}/${command}`, { method: modifying ? 'POST' : 'GET', body: authCode ? { authCode } : undefined });
    if (session !== currentSession || requestId !== containerRequest || !$('#containers-dialog').open) return;
    if (modifying) {
      await loadContainers();
    } else {
      $('#container-output-title').textContent = `${container.name || container.id} · ${command}`;
      if (command === 'inspect') {
        const info = result.data;
        const details = {
          restartPolicy: info.HostConfig && info.HostConfig.RestartPolicy,
          mounts: info.Mounts,
          networks: info.NetworkSettings && info.NetworkSettings.Networks
        };
        $('#container-output-content').textContent = `Read-only configuration:\n${JSON.stringify(details, null, 2)}\n\nFull inspection (may contain secrets):\n${JSON.stringify(info, null, 2)}`;
      } else {
        $('#container-output-content').textContent = result.output || 'No output.';
      }
      $('#container-output').hidden = false;
      $('#containers-status').textContent = '';
    }
  } catch (error) {
    if (session === currentSession && requestId === containerRequest && $('#containers-dialog').open) $('#containers-status').textContent = error.message;
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
      ...(repo.lastDeployed || repo.composeAttempted ? [action('Containers', 'secondary', () => { containerRepoId = repo.id; $('#containers-title').textContent = name; $('#container-output').hidden = true; $('#container-output-content').textContent = ''; $('#container-list').replaceChildren(); $('#containers-dialog').showModal(); loadContainers(); }, busy)] : []),
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
      clearSession();
      $('#login-error').textContent = 'Session expired. Sign in again.';
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

function ioCounters(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  if (parts.length !== 2) return null;
  return parts.map(part => {
    const match = part.trim().match(/^(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i);
    if (!match) return null;
    const units = { b: 1, kb: 1000, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776 };
    return Number(match[1]) * units[match[2].toLowerCase()];
  });
}

function recordMetrics(data) {
  const now = Date.now();
  function record(key, value) {
    const points = metricHistory.get(key) || [];
    points.push({ time: now, value: Number.isFinite(value) ? value : null });
    if (points.length > 120) points.shift();
    metricHistory.set(key, points);
  }
  record('runtime-cpu', data.runtime.cpuPercent);
  if (!data.host.error) {
    record('host-cpu', data.host.cpuPercent);
    record('host-memory', data.host.memoryTotal > 0 ? 100 * data.host.memoryUsed / data.host.memoryTotal : null);
  } else {
    record('host-cpu', null);
    record('host-memory', null);
  }
  const present = new Set();
  for (const container of data.containers) {
    if (container.error || !container.id) continue;
    const key = `${container.repoId}:${container.id}`;
    present.add(key);
    record(`${key}:cpu`, containerPercent(container.cpu));
    record(`${key}:memory`, containerPercent(container.memoryPercent));
    const current = { time: now, network: ioCounters(container.network), block: ioCounters(container.block) };
    const previous = previousIo.get(key);
    for (const type of ['network', 'block']) {
      for (let index = 0; index < 2; index++) {
        const value = current[type] && current[type][index];
        const before = previous && previous[type] && previous[type][index];
        const valid = value !== null && value !== undefined && before !== null && before !== undefined && now > previous.time && value >= before;
        record(`${key}:${type}:${index}`, valid ? (value - before) / ((now - previous.time) / 1000) : null);
      }
    }
    previousIo.set(key, current);
  }
  for (const key of previousIo.keys()) if (!present.has(key)) previousIo.delete(key);
  for (const key of metricHistory.keys()) {
    if (key.includes(':') && ![...present].some(id => key.startsWith(`${id}:`))) metricHistory.delete(key);
  }
}

function metricGraph(key, label, unit) {
  const points = metricHistory.get(key) || [];
  const wrapper = element('div', 'history-graph');
  const values = points.filter(point => point.value !== null);
  wrapper.append(element('p', 'graph-title', `${label} · last ${points.length} samples`));
  if (values.length < 2) {
    wrapper.append(element('p', 'metric-note', 'Waiting for more samples…'));
    return wrapper;
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 300 80');
  svg.setAttribute('role', 'img');
  const maximum = Math.max(...values.map(point => point.value), unit === '%' ? 100 : 1);
  const latest = points[points.length - 1].value;
  svg.setAttribute('aria-label', `${label}, latest ${latest === null ? 'unavailable' : unit === '%' ? percent(latest) : `${formatBytes(latest)}/s`}, graph maximum ${unit === '%' ? percent(maximum) : `${formatBytes(maximum)}/s`}`);
  const first = points[0].time;
  const duration = Math.max(1, points[points.length - 1].time - first);
  let segment = [];
  function drawSegment() {
    if (segment.length) {
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', segment.join(' '));
      svg.append(line);
      segment = [];
    }
  }
  for (const point of points) {
    if (point.value === null) drawSegment();
    else segment.push(`${((point.time - first) / duration * 300).toFixed(1)},${(78 - point.value / maximum * 74).toFixed(1)}`);
  }
  drawSegment();
  wrapper.append(svg, element('p', 'metric-note', `Scale: 0 to ${unit === '%' ? percent(maximum) : `${formatBytes(maximum)}/s`}. ${new Date(first).toLocaleTimeString()} – ${new Date(points[points.length - 1].time).toLocaleTimeString()}`));
  return wrapper;
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
  processPanel.append(metricGraph('runtime-cpu', 'Process CPU', '%'));
  processPanel.append(element('p', 'metric-detail-line', `Resident memory: ${formatBytes(runtime.rss)} · Heap used: ${formatBytes(runtime.heapUsed)}`), element('p', 'metric-detail-line', `Uptime: ${Math.floor(runtime.uptime / 60)} min · Platform: ${runtime.platform}`));
  const hostPanel = element('section', 'metric-panel');
  hostPanel.append(element('h2', '', 'Docker host'), element('p', 'metric-note', 'CPU and memory of the configured host, not necessarily your desktop.'));
  if (host.error) hostPanel.append(element('p', 'metric-unavailable', host.error));
  else {
    const memoryPercent = host.memoryTotal > 0 ? 100 * host.memoryUsed / host.memoryTotal : null;
    hostPanel.append(metricBar('CPU', host.cpuPercent, percent(host.cpuPercent)), metricBar('Memory', memoryPercent, `${formatBytes(host.memoryUsed)} / ${formatBytes(host.memoryTotal)}${memoryPercent === null ? '' : ` · ${percent(memoryPercent)}`}`));
    hostPanel.append(metricGraph('host-cpu', 'Host CPU', '%'), metricGraph('host-memory', 'Host memory', '%'));
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
      if (container.id) {
        const key = `${container.repoId}:${container.id}`;
        panel.append(metricGraph(`${key}:cpu`, 'Container CPU', '%'), metricGraph(`${key}:memory`, 'Container memory', '%'));
        for (const [type, index, label] of [['network', 0, 'Network received'], ['network', 1, 'Network sent'], ['block', 0, 'Disk read'], ['block', 1, 'Disk written']]) {
          panel.append(metricGraph(`${key}:${type}:${index}`, label, 'bytes/s'));
        }
      }
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
    recordMetrics(data);
    renderMetrics();
  } catch (error) {
    if (session === currentSession) {
      metricsData = null;
      metricsError = error.message;
      previousIo.clear();
      const time = Date.now();
      for (const points of metricHistory.values()) {
        points.push({ time, value: null });
        if (points.length > 120) points.shift();
      }
      renderMetrics();
    }
  } finally {
    metricsRefreshing = false;
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
  } finally {
    submit.disabled = false;
  }
});
function clearSession() {
  session++;
  token = '';
  sessionStorage.removeItem('deploySession');
  repos = [];
  repoSnapshot = null;
  metricsData = null;
  metricsError = '';
  metricHistory.clear();
  previousIo.clear();
  renderMetrics();
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
$('#containers-dialog').addEventListener('close', () => {
  containerRequest++;
  containerRepoId = null;
  $('#container-list').replaceChildren();
  $('#container-output-content').textContent = '';
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
if (!token) $('#login-dialog').showModal();
else { refresh(); refreshMetrics(); }
setInterval(refresh, 3000);
setInterval(refreshMetrics, 15000);
