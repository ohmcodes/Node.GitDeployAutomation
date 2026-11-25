'use strict';

const $ = selector => document.querySelector(selector);
let token = sessionStorage.getItem('deployToken') || '';
let repos = [];
let filter = 'all';
let selected = null;
let refreshing = false;

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
    const busy = ['cloning', 'deploying', 'checking'].includes(repo.status);
    const card = element('article', 'repo');
    const icon = element('div', 'repo-icon', '⌘');
    const info = element('div', 'repo-info');
    const name = repo.url.replace(/\/$/, '').split('/').pop().replace(/\.git$/, '');
    const title = element('div', 'repo-title');
    title.append(element('h3', '', name), element('span', `badge ${repo.status}`, repo.status));
    info.append(title, element('p', 'repo-url', repo.url), element('p', 'repo-meta', `⑂ ${repo.branch}  ·  ${repo.watching ? 'Watching enabled' : 'Watching paused'}  ·  ${repo.lastDeployed ? `Deployed ${new Date(repo.lastDeployed).toLocaleString()}` : 'Not deployed yet'}`));
    if (repo.message) info.append(element('p', 'error', repo.message));
    const buttons = element('div', 'actions');
    buttons.append(
      action('Activity', 'secondary', () => { $('#log-title').textContent = name; $('#log-content').textContent = repo.log || 'No activity yet.'; $('#log-dialog').showModal(); }),
      action('Script', 'secondary', () => { selected = repo; $('#edit-script').value = repo.script; $('#settings-dialog').showModal(); }, busy),
      action(repo.watching ? 'Pause' : 'Watch', 'secondary', () => change(repo, 'PATCH', { watching: !repo.watching }), busy),
      action('Deploy ↗', 'deploy', () => change(repo, 'POST', undefined, '/deploy'), busy),
      action('×', 'remove', () => { if (confirm(`Remove ${name}? Its clone will be deleted, but running containers will not be stopped.`)) change(repo, 'DELETE'); }, busy)
    );
    buttons.lastChild.setAttribute('aria-label', `Remove ${name}`);
    card.append(icon, info, buttons);
    list.append(card);
  }
}

async function refresh() {
  if (!token || refreshing) return;
  refreshing = true;
  try {
    repos = await api('/api/repos');
    render();
    notice('');
    return true;
  } catch (error) {
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

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  token = $('#token').value;
  const success = await refresh();
  if (success) {
    sessionStorage.setItem('deployToken', token);
    $('#login-dialog').close();
    $('#token').value = '';
  } else if (token) $('#login-error').textContent = 'Could not connect to the server. Please try again.';
});
$('#logout').addEventListener('click', () => {
  token = '';
  sessionStorage.removeItem('deployToken');
  repos = [];
  render();
  $('#login-dialog').showModal();
});
$('#add-open').addEventListener('click', () => $('#add-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => {
  document.querySelector('.nav.active').classList.remove('active');
  button.classList.add('active');
  filter = button.dataset.filter;
  $('#view-title').textContent = button.textContent.trim().replace(/^[▦◉◇△]\s*/, '');
  render();
}));
$('#add-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/repos', { method: 'POST', body: { url: $('#url').value, branch: $('#branch').value, script: $('#new-script').value } });
    $('#add-dialog').close();
    $('#add-form').reset();
    notice('');
    await refresh();
  } catch (error) {
    notice(error.message);
    $('#add-dialog').close();
  }
});
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#settings-dialog').close();
  await change(selected, 'PATCH', { script: $('#edit-script').value });
});
if (!token) $('#login-dialog').showModal();
else refresh();
setInterval(refresh, 3000);
