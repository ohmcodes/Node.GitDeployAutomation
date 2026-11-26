export function createContainerScreen({ $, element, action, api, confirmWithAuthenticator, getSession }) {
  let containerRequest = 0;
  let containerRepoId = null;

  async function loadContainers() {
    const requestId = ++containerRequest;
    const currentSession = getSession();
    const repoId = containerRepoId;
    $('#containers-status').textContent = 'Loading containers…';
    try {
      const containers = await api(`/api/repos/${repoId}/containers`);
      if (getSession() !== currentSession || requestId !== containerRequest || !$('#containers-dialog').open) return;
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
      if (getSession() === currentSession && requestId === containerRequest && $('#containers-dialog').open) $('#containers-status').textContent = error.message;
    }
  }

  function inspectionTable(value) {
    const table = element('table', 'inspection-table');
    const heading = document.createElement('thead');
    const header = document.createElement('tr');
    for (const label of ['Property', 'Value']) {
      const cell = element('th', '', label);
      cell.scope = 'col';
      header.append(cell);
    }
    heading.append(header);
    const rows = document.createElement('tbody');
    for (const [key, item] of Object.entries(value)) {
      const row = document.createElement('tr');
      const name = element('th', '', key);
      name.scope = 'row';
      const cell = document.createElement('td');
      if (item !== null && typeof item === 'object') {
        const entries = Object.keys(item).length;
        if (!entries) {
          cell.textContent = Array.isArray(item) ? '[]' : '{}';
        } else {
          const details = document.createElement('details');
          const kind = Array.isArray(item) ? 'Array' : 'Object';
          details.append(element('summary', '', `${kind} · ${entries} ${entries === 1 ? 'entry' : 'entries'}`));
          details.addEventListener('toggle', () => {
            if (details.open && details.children.length === 1) details.append(inspectionTable(item));
          });
          cell.append(details);
        }
      } else {
        cell.textContent = JSON.stringify(item);
      }
      row.append(name, cell);
      rows.append(row);
    }
    table.append(heading, rows);
    return table;
  }

  function setInspectionView(view) {
    const table = view === 'table';
    $('#inspection-table').hidden = !table;
    $('#container-output-content').hidden = table;
    $('#inspection-table-button').setAttribute('aria-pressed', String(table));
    $('#inspection-json-button').setAttribute('aria-pressed', String(!table));
  }

  function clearContainerOutput() {
    $('#container-output').hidden = true;
    $('#inspection-views').hidden = true;
    $('#inspection-table').replaceChildren();
    $('#container-output-content').textContent = '';
    $('#container-output-content').hidden = false;
  }

  async function containerOperation(container, command) {
    const modifying = !['inspect', 'logs', 'processes'].includes(command);
    if (modifying && !confirm(`${command.toUpperCase()} ${container.name || container.id}? This can interrupt the service. The repository watcher will remain unchanged and may redeploy it.`)) return;
    const repoId = containerRepoId;
    const currentSession = getSession();
    let authCode;
    if (['stop', 'kill', 'restart', 'pause'].includes(command)) {
      authCode = await confirmWithAuthenticator(`${command.toUpperCase()} ${container.name || container.id}. The service may be interrupted.`);
      if (!authCode || getSession() !== currentSession || containerRepoId !== repoId || !$('#containers-dialog').open) return;
    }
    const requestId = ++containerRequest;
    $('#containers-status').textContent = `${command} in progress…`;
    try {
      const result = await api(`/api/repos/${repoId}/containers/${container.id}/${command}`, { method: modifying ? 'POST' : 'GET', body: authCode ? { authCode } : undefined });
      if (getSession() !== currentSession || requestId !== containerRequest || !$('#containers-dialog').open) return;
      if (modifying) {
        await loadContainers();
      } else {
        clearContainerOutput();
        $('#container-output-title').textContent = `${container.name || container.id} · ${command}`;
        if (command === 'inspect') {
          const info = result.data;
          if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('Invalid container inspection data');
          $('#inspection-table').append(inspectionTable(info));
          $('#container-output-content').textContent = JSON.stringify(info, null, 2);
          $('#inspection-views').hidden = false;
          setInspectionView('table');
        } else {
          $('#container-output-content').textContent = result.output || 'No output.';
        }
        $('#container-output').hidden = false;
        $('#containers-status').textContent = '';
      }
    } catch (error) {
      if (getSession() === currentSession && requestId === containerRequest && $('#containers-dialog').open) $('#containers-status').textContent = error.message;
    }
  }


  function openContainers(repo, name) {
    containerRepoId = repo.id;
    $('#containers-title').textContent = name;
    clearContainerOutput();
    $('#container-list').replaceChildren();
    $('#containers-dialog').showModal();
    void loadContainers();
  }

  $('#inspection-table-button').addEventListener('click', () => setInspectionView('table'));
  $('#inspection-json-button').addEventListener('click', () => setInspectionView('json'));
  $('#containers-dialog').addEventListener('close', () => {
    containerRequest++;
    containerRepoId = null;
    $('#container-list').replaceChildren();
    clearContainerOutput();
  });

  return { openContainers };
}
