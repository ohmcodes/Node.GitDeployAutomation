const key = 'git-deploy-display-settings';
const graphs = ['cpu', 'memory', 'network', 'block'];

export function loadPreferences() {
  let saved = {};
  try {
    const raw = localStorage.getItem(key);
    if (raw) saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid settings');
  } catch (error) {
    console.warn('Unable to load display settings:', error);
    saved = {};
  }
  const column = value => [1, 2, 3].includes(value) ? value : 1;
  const ids = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.length <= 110) : [];
  return {
    expandedRepos: ids(saved.expandedRepos),
    expandedContainers: ids(saved.expandedContainers),
    visibleGraphs: Array.isArray(saved.visibleGraphs) ? saved.visibleGraphs.filter(item => graphs.includes(item)) : [...graphs],
    repoColumns: column(saved.repoColumns),
    containerColumns: column(saved.containerColumns),
    graphColumns: column(saved.graphColumns),
    filter: ['all', 'watching', 'deployed', 'error'].includes(saved.filter) ? saved.filter : 'all',
    accent: ['default', 'blue', 'purple', 'orange', 'pink'].includes(saved.accent) ? saved.accent : 'default'
  };
}

export function savePreferences(settings) {
  try {
    localStorage.setItem(key, JSON.stringify(settings));
  } catch (error) {
    console.warn('Unable to save display settings:', error);
    document.querySelector('#notice').textContent = 'Could not save display settings in this browser.';
  }
}
