export function createMetricsScreen({ $, element, action, api, showPage, getRepos, getToken, getSession }) {
  let metricsRefreshing = false;
  let metricsData = null;
  let metricsError = '';
  const metricHistory = new Map();
  const previousIo = new Map();
  const expandedContainers = new Set();
  const visibleGraphs = new Set(['cpu', 'memory', 'network', 'block']);
  let containerColumns = 1;
  let graphColumns = 1;

  document.querySelectorAll('[data-graph-metric]').forEach(button => button.addEventListener('click', () => {
    const metric = button.dataset.graphMetric;
    if (visibleGraphs.has(metric)) visibleGraphs.delete(metric);
    else visibleGraphs.add(metric);
    button.setAttribute('aria-pressed', String(visibleGraphs.has(metric)));
    renderMetrics();
  }));
  for (const [attribute, update] of [
    ['containerColumns', value => { containerColumns = value; }],
    ['graphColumns', value => { graphColumns = value; }]
  ]) {
    const buttons = document.querySelectorAll(attribute === 'containerColumns' ? '[data-container-columns]' : '[data-graph-columns]');
    buttons.forEach(button => button.addEventListener('click', () => {
      update(Number(button.dataset[attribute]));
      buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      renderMetrics();
    }));
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

  function graphGroup(graphs) {
    const group = element('div', 'graph-grid');
    group.style.setProperty('--columns', graphColumns);
    for (const [type, key, label, unit] of graphs) {
      if (visibleGraphs.has(type)) group.append(metricGraph(key, label, unit));
    }
    return group;
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
        const repo = getRepos().find(item => item.id === node.dataset.repoId);
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
    const focusedContainer = detail.contains(document.activeElement) && document.activeElement.dataset.containerToggle;
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
    processPanel.append(graphGroup([['cpu', 'runtime-cpu', 'Process CPU', '%']]));
    processPanel.append(element('p', 'metric-detail-line', `Resident memory: ${formatBytes(runtime.rss)} · Heap used: ${formatBytes(runtime.heapUsed)}`), element('p', 'metric-detail-line', `Uptime: ${Math.floor(runtime.uptime / 60)} min · Platform: ${runtime.platform}`));
    const hostPanel = element('section', 'metric-panel');
    hostPanel.append(element('h2', '', 'Docker host'), element('p', 'metric-note', 'CPU and memory of the configured host, not necessarily your desktop.'));
    if (host.error) hostPanel.append(element('p', 'metric-unavailable', host.error));
    else {
      const memoryPercent = host.memoryTotal > 0 ? 100 * host.memoryUsed / host.memoryTotal : null;
      hostPanel.append(metricBar('CPU', host.cpuPercent, percent(host.cpuPercent)), metricBar('Memory', memoryPercent, `${formatBytes(host.memoryUsed)} / ${formatBytes(host.memoryTotal)}${memoryPercent === null ? '' : ` · ${percent(memoryPercent)}`}`));
      hostPanel.append(graphGroup([['cpu', 'host-cpu', 'Host CPU', '%'], ['memory', 'host-memory', 'Host memory', '%']]));
    }
    grid.append(processPanel, hostPanel);
    detail.append(grid);
    const containerSection = element('section', 'container-section');
    containerSection.append(element('h2', '', 'Managed containers'), element('p', 'metric-note', 'Running containers reported by managed Compose projects. CPU is relative to one core and may exceed 100%.'));
    if (!containers.length) containerSection.append(element('p', 'metric-unavailable', 'No running managed containers reported.'));
    const containerGrid = element('div', 'container-grid');
    containerGrid.style.setProperty('--columns', containerColumns);
    for (const container of containers) {
      const repo = getRepos().find(item => item.id === container.repoId);
      const panel = element('article', 'metric-panel container-panel');
      const key = `${container.repoId}:${container.id || 'error'}`;
      const name = container.name || 'Container metrics unavailable';
      const heading = element('div', 'container-panel-heading');
      const title = element('div', 'container-panel-title');
      title.append(element('h3', '', name), element('p', 'metric-note', repo ? repo.url : `Repository ${container.repoId}`));
      if (container.error) title.append(element('p', 'metric-unavailable', container.error));
      else title.append(element('p', 'metric-note', `CPU ${container.cpu || 'unavailable'} · Memory ${container.memoryPercent || 'unavailable'}`));
      const content = element('div', 'container-panel-details');
      content.id = `container-metrics-${container.repoId}-${container.id || 'error'}`;
      content.hidden = !expandedContainers.has(key);
      const toggle = action('', 'secondary', () => {
        content.hidden = !content.hidden;
        if (content.hidden) expandedContainers.delete(key);
        else expandedContainers.add(key);
        updateToggle();
      });
      toggle.dataset.containerToggle = key;
      toggle.setAttribute('aria-controls', content.id);
      function updateToggle() {
        toggle.textContent = content.hidden ? 'Expand' : 'Collapse';
        toggle.setAttribute('aria-expanded', String(!content.hidden));
        toggle.setAttribute('aria-label', `${content.hidden ? 'Expand' : 'Collapse'} ${name}`);
      }
      updateToggle();
      heading.append(title, toggle);
      panel.append(heading);
      if (container.error) toggle.hidden = true;
      else {
        const cpu = containerPercent(container.cpu);
        const memory = containerPercent(container.memoryPercent);
        content.append(metricBar('CPU · one core', cpu, container.cpu || 'Unavailable', Math.max(100, cpu || 0)));
        content.append(metricBar('Memory', memory, `${container.memory || 'Unavailable'}${container.memoryPercent ? ` · ${container.memoryPercent}` : ''}`));
        content.append(element('p', 'metric-detail-line', `Network I/O: ${container.network || 'Unavailable'} · Block I/O: ${container.block || 'Unavailable'}`));
        if (container.id) {
          const graphs = [['cpu', `${key}:cpu`, 'Container CPU', '%'], ['memory', `${key}:memory`, 'Container memory', '%']];
          for (const [type, index, label] of [['network', 0, 'Network received'], ['network', 1, 'Network sent'], ['block', 0, 'Disk read'], ['block', 1, 'Disk written']]) {
            graphs.push([type, `${key}:${type}:${index}`, label, 'bytes/s']);
          }
          content.append(graphGroup(graphs));
        }
      }
      panel.append(content);
      containerGrid.append(panel);
      if (focusedContainer === key && !toggle.hidden) toggle.dataset.restoreFocus = 'true';
    }
    containerSection.append(containerGrid);
    detail.append(containerSection);
    const restore = detail.querySelector('[data-restore-focus]');
    if (restore) { delete restore.dataset.restoreFocus; restore.focus(); }
    renderRepoMetrics();
  }

  async function refreshMetrics() {
    if (!getToken() || metricsRefreshing) return;
    metricsRefreshing = true;
    const currentSession = getSession();
    try {
      const data = await api('/api/metrics');
      if (getSession() !== currentSession) return;
      metricsData = data;
      metricsError = '';
      recordMetrics(data);
      renderMetrics();
    } catch (error) {
      if (getSession() === currentSession) {
        metricsData = null;
        metricsError = error.message;
        previousIo.clear();
        expandedContainers.clear();
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


  function resetMetrics() {
    metricsData = null;
    metricsError = '';
    metricHistory.clear();
    previousIo.clear();
    renderMetrics();
  }

  return { renderRepoMetrics, refreshMetrics, resetMetrics };
}
