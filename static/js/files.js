import { api } from './api.js';
import { h, toast, modal, confirmDialog, promptDialog, formatBytes, formatDate } from './ui.js';
import { shellQuote } from './terminal.js';

let host = null;
let ctxRef = null;
let mounted = false;
let cwd = '';
let showHidden = false;
let entries = [];
let selection = new Set();
let lastIndex = -1;
let clipboard = { mode: null, paths: [] };
let saveTimer = null;
let editor = null;
let menu = null;
let uploads = [];
let tabs = [];
let activeTabId = null;

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const HISTORY_LIMIT = 50;

function newId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < 8; i += 1) id += ID_CHARS[bytes[i] % ID_CHARS.length];
  return id;
}

function currentTab() {
  return tabs.find((tab) => tab.id === activeTabId) || null;
}

function tabTitle(path) {
  if (!path || path === '/') return '/';
  return path.replace(/\/+$/, '').split('/').pop() || '/';
}

function makeTab(path, id) {
  return {
    id: id || newId(),
    title: tabTitle(path),
    cwd: path || '/',
    history: [path || '/'],
    historyIndex: 0,
    entries: [],
    selection: new Set(),
    lastIndex: -1,
    loaded: false,
    loading: false,
    requestId: 0
  };
}

function captureActiveTab() {
  const tab = currentTab();
  if (!tab) return;
  tab.cwd = cwd || '/';
  tab.title = tabTitle(tab.cwd);
  tab.entries = entries;
  tab.selection = new Set(selection);
  tab.lastIndex = lastIndex;
}

function restoreTab(tab) {
  if (!tab) return;
  cwd = tab.cwd || '/';
  entries = Array.isArray(tab.entries) ? tab.entries : [];
  selection = new Set(tab.selection || []);
  lastIndex = typeof tab.lastIndex === 'number' ? tab.lastIndex : -1;
}

function savePrefs() {
  captureActiveTab();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    api
      .post('/api/prefs', {
        files: {
          cwd,
          show_hidden: showHidden,
          active: activeTabId,
          tabs: tabs.map((tab) => ({
            id: tab.id,
            title: tab.title,
            cwd: tab.cwd,
            history: tab.history,
            history_index: tab.historyIndex
          }))
        }
      })
      .catch((err) => toast(err.message, 'danger'));
  }, 300);
}

function renderHistoryButtons() {
  if (!host) return;
  const previous = host.querySelector('.history-previous');
  const next = host.querySelector('.history-next');
  if (!previous || !next) return;
  const tab = currentTab();
  const index = tab ? tab.historyIndex : 0;
  const previousPath = tab && index > 0 ? tab.history[index - 1] : null;
  const nextPath = tab && index < tab.history.length - 1 ? tab.history[index + 1] : null;
  previous.disabled = !tab || tab.loading || !previousPath;
  next.disabled = !tab || tab.loading || !nextPath;
  previous.title = previousPath ? 'Previous: ' + previousPath : 'No previous directory';
  next.title = nextPath ? 'Next: ' + nextPath : 'No next directory';
}

function goHistory(offset) {
  const tab = currentTab();
  if (!tab || tab.loading) return;
  const index = tab.historyIndex + offset;
  if (index < 0 || index >= tab.history.length) return;
  load(tab.history[index], { type: 'index', index });
}

function renderFileTabs() {
  if (!host) return;
  const strip = host.querySelector('.file-tabs');
  if (!strip) return;
  strip.textContent = '';
  for (const tab of tabs) {
    const close = h(
      'button',
      {
        class: 'close',
        type: 'button',
        title: 'Close file tab',
        'aria-label': 'Close file tab',
        onclick: (event) => {
          event.stopPropagation();
          closeFileTab(tab);
        }
      },
      '\u00d7'
    );
    strip.appendChild(
      h(
        'button',
        {
          class: 'file-tab' + (tab.id === activeTabId ? ' active' : ''),
          type: 'button',
          title: tab.cwd,
          onclick: () => selectFileTab(tab.id),
          onmousedown: (event) => {
            if (event.button === 1) event.preventDefault();
          },
          onauxclick: (event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            event.stopPropagation();
            closeFileTab(tab);
          }
        },
        h('span', { text: tab.title || tabTitle(tab.cwd) }),
        close
      )
    );
  }
  strip.appendChild(
    h(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        title: 'New file tab',
        'aria-label': 'New file tab',
        onclick: () => addFileTab(cwd || '/')
      },
      '+'
    )
  );
}

function selectFileTab(id) {
  if (id === activeTabId) return;
  const tab = tabs.find((item) => item.id === id);
  if (!tab) return;
  captureActiveTab();
  activeTabId = id;
  restoreTab(tab);
  closeMenu();
  renderAll();
  savePrefs();
  if (!tab.loaded && !tab.loading) load(tab.cwd);
}

function addFileTab(path, id) {
  captureActiveTab();
  const tab = makeTab(path || cwd || '/', id);
  tabs.push(tab);
  activeTabId = tab.id;
  restoreTab(tab);
  closeMenu();
  renderAll();
  savePrefs();
  load(tab.cwd);
  return tab;
}

function closeFileTab(tab) {
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  tabs.splice(index, 1);
  if (!tabs.length) {
    activeTabId = null;
    addFileTab(tab.cwd || '/');
    return;
  }
  if (activeTabId === tab.id) {
    const next = tabs[Math.min(index, tabs.length - 1)];
    activeTabId = next.id;
    restoreTab(next);
    renderAll();
    if (!next.loaded && !next.loading) load(next.cwd);
  } else {
    renderFileTabs();
  }
  closeMenu();
  savePrefs();
}

function join(dir, name) {
  if (dir === '/') return '/' + name;
  return dir.replace(/\/+$/, '') + '/' + name;
}

function parentOf(path) {
  if (!path || path === '/') return '/';
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  if (index <= 0) return '/';
  return trimmed.slice(0, index);
}

function selectedEntries() {
  return entries.filter((entry) => selection.has(entry.name));
}

function selectedPaths() {
  return selectedEntries().map((entry) => join(cwd, entry.name));
}

function closeMenu() {
  if (menu) {
    menu.remove();
    menu = null;
  }
}

function openMenu(event, entry, directoryPath) {
  closeMenu();
  if (entry && !selection.has(entry.name)) {
    selection = new Set([entry.name]);
    lastIndex = entries.indexOf(entry);
    updateSelectionStyles();
  }
  const items = [];
  const picked = selectedEntries();
  const single = picked.length === 1 ? picked[0] : null;
  if (single) {
    items.push({ label: 'Open', action: () => openEntry(single) });
    if (single.type !== 'dir') {
      items.push({ label: 'Edit', action: () => editFile(join(cwd, single.name)) });
      items.push({ label: 'Edit with nano', action: () => nanoFile(join(cwd, single.name)) });
      items.push({ label: 'Download', action: () => download(join(cwd, single.name)) });
    }
    items.push({ label: 'Rename', action: () => renameSelected() });
  }
  if (picked.length) {
    items.push({ label: 'Copy', action: () => setClipboard('copy') });
    items.push({ label: 'Cut', action: () => setClipboard('cut') });
  }
  items.push({ label: 'Paste', action: () => paste(), disabled: !clipboard.paths.length });
  if (picked.length) items.push({ label: 'Delete', action: () => deleteSelected(), danger: true });
  if (single) items.push({ label: 'Chmod', action: () => chmodSelected() });
  const terminalPath = single ? (single.type === 'dir' ? join(cwd, single.name) : cwd) : directoryPath || cwd;
  items.push({ sep: true });
  items.push({ label: 'Open terminal here', action: () => openTerminalHere(terminalPath) });
  items.push({ label: 'Move terminal here', action: () => moveTerminalHere(terminalPath) });
  menu = h('div', { class: 'ctx-menu', role: 'menu', style: { left: event.clientX + 'px', top: event.clientY + 'px' } });
  for (const item of items) {
    if (item.sep) {
      menu.appendChild(h('div', { class: 'ctx-sep' }));
      continue;
    }
    menu.appendChild(
      h(
        'button',
        {
          class: 'ctx-item' + (item.danger ? ' danger' : ''),
          type: 'button',
          role: 'menuitem',
          disabled: item.disabled === true,
          onclick: () => {
            closeMenu();
            item.action();
          }
        },
        item.label
      )
    );
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.bottom > window.innerHeight) menu.style.top = Math.max(6, window.innerHeight - rect.height - 6) + 'px';
  if (rect.right > window.innerWidth) menu.style.left = Math.max(6, window.innerWidth - rect.width - 6) + 'px';
  const first = menu.querySelector('button:not(:disabled)');
  if (first) first.focus();
}

function onDocumentDown(event) {
  if (menu && !menu.contains(event.target)) closeMenu();
}

function onDocumentKey(event) {
  if (!mounted || !host) return;
  if (event.key === 'Escape' && menu) {
    event.preventDefault();
    closeMenu();
    return;
  }
  if (editor) return;
  const target = event.target;
  const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return;
  if (!host || host.classList.contains('hidden')) return;
  const meta = event.ctrlKey || event.metaKey;
  if (event.key === 'Delete') {
    if (selection.size) {
      event.preventDefault();
      deleteSelected();
    }
    return;
  }
  if (event.key === 'F2') {
    if (selection.size === 1) {
      event.preventDefault();
      renameSelected();
    }
    return;
  }
  if (meta && event.key.toLowerCase() === 'c') {
    if (selection.size) {
      event.preventDefault();
      setClipboard('copy');
    }
    return;
  }
  if (meta && event.key.toLowerCase() === 'x') {
    if (selection.size) {
      event.preventDefault();
      setClipboard('cut');
    }
    return;
  }
  if (meta && event.key.toLowerCase() === 'v') {
    if (clipboard.paths.length) {
      event.preventDefault();
      paste();
    }
    return;
  }
  if (event.key === 'Backspace') {
    event.preventDefault();
    navigate(parentOf(cwd));
  }
}

function setClipboard(mode) {
  const paths = selectedPaths();
  if (!paths.length) return;
  clipboard = { mode, paths };
  toast((mode === 'cut' ? 'Cut ' : 'Copied ') + paths.length + ' item(s)', 'ok');
}

async function paste() {
  if (!clipboard.paths.length) return;
  const op = clipboard.mode === 'cut' ? 'move' : 'copy';
  try {
    await api.post('/api/files/' + op, { sources: clipboard.paths, dest_dir: cwd });
    toast(op === 'move' ? 'Moved' : 'Copied', 'ok');
    if (op === 'move') clipboard = { mode: null, paths: [] };
    await refresh();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

async function deleteSelected() {
  const picked = selectedEntries();
  if (!picked.length) return;
  const names = picked.map((entry) => entry.name);
  const ok = await confirmDialog('Delete ' + names.length + ' item(s)?\n\n' + names.join('\n'), {
    danger: true,
    title: 'Delete',
    confirmLabel: 'Delete'
  });
  if (!ok) return;
  try {
    await api.post('/api/files/delete', { paths: picked.map((entry) => join(cwd, entry.name)) });
    selection = new Set();
    toast('Deleted ' + names.length + ' item(s)', 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

async function renameSelected() {
  const picked = selectedEntries();
  if (picked.length !== 1) return;
  const entry = picked[0];
  const value = await promptDialog('Rename', 'New name for "' + entry.name + '"', entry.name);
  if (value === null) return;
  const name = value.trim();
  if (!name || name === entry.name) return;
  if (name.includes('/')) {
    toast('Name cannot contain /', 'danger');
    return;
  }
  try {
    await api.post('/api/files/rename', { src: join(cwd, entry.name), dst: join(cwd, name) });
    selection = new Set([name]);
    toast('Renamed', 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

async function chmodSelected() {
  const picked = selectedEntries();
  if (picked.length !== 1) return;
  const entry = picked[0];
  const value = await promptDialog('Change permissions', 'Octal mode for "' + entry.name + '"', entry.octal || '644');
  if (value === null) return;
  const mode = value.trim();
  if (!/^[0-7]{3,4}$/.test(mode)) {
    toast('Mode must be 3 or 4 octal digits', 'danger');
    return;
  }
  try {
    await api.post('/api/files/chmod', { path: join(cwd, entry.name), mode });
    toast('Permissions updated', 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

function download(path) {
  const link = h('a', { href: '/api/files/download?path=' + encodeURIComponent(path), download: '' });
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => link.remove(), 1000);
}

function openTerminalHere(path) {
  if (ctxRef && ctxRef.openTerminal) ctxRef.openTerminal('cd -- ' + shellQuote(path));
}

function moveTerminalHere(path) {
  if (ctxRef && ctxRef.moveTerminal) ctxRef.moveTerminal('cd -- ' + shellQuote(path));
}

function nanoFile(path) {
  if (ctxRef && ctxRef.openTerminal) ctxRef.openTerminal('nano -- ' + shellQuote(path));
}

function openEntry(entry) {
  const path = join(cwd, entry.name);
  if (entry.type === 'dir') {
    navigate(path);
    return;
  }
  if (entry.type === 'link' && entry.target_type === 'dir') {
    navigate(path);
    return;
  }
  editFile(path);
}

function openSearchResult(entry) {
  if (!entry || !entry.path) return;
  if (entry.type === 'dir' || (entry.type === 'link' && entry.target_type === 'dir')) {
    navigate(entry.path);
    return;
  }
  editFile(entry.path);
}

function searchFiles() {
  if (!host) return;
  const directory = cwd || '/';
  const input = h('input', {
    class: 'input file-search-input',
    type: 'search',
    placeholder: 'File or folder name',
    'aria-label': 'Search file and folder names',
    onkeydown: (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      runSearch();
    }
  });
  const status = h('div', { class: 'file-search-status muted', text: 'Search within ' + directory + ' and its subdirectories.' });
  const results = h('div', { class: 'file-search-results', role: 'listbox', 'aria-label': 'Search results' });
  let items = [];
  let selected = null;
  let searching = false;
  let searched = false;
  let requestId = 0;

  function renderResults() {
    results.textContent = '';
    selected = items.length ? items[0] : null;
    if (!items.length && searched) {
      results.appendChild(h('div', { class: 'file-search-empty', text: 'No matching files or folders.' }));
      return;
    }
    items.forEach((item, index) => {
      const row = h(
        'button',
        {
          class: 'file-search-result' + (index === 0 ? ' selected' : ''),
          type: 'button',
          role: 'option',
          'aria-selected': index === 0 ? 'true' : 'false',
          dataset: { index: String(index) },
          onclick: () => {
            selected = item;
            for (const child of results.children) {
              const active = child === row;
              child.classList.toggle('selected', active);
              child.setAttribute('aria-selected', active ? 'true' : 'false');
            }
          }
        },
        glyph(item),
        h(
          'span',
          { class: 'file-search-result-text' },
          h('span', { class: 'file-search-result-name', text: item.name }),
          h('span', { class: 'file-search-result-path muted', text: item.relative_path || item.path || item.name })
        ),
        h('span', { class: 'file-search-result-type muted', text: item.type === 'dir' ? 'Folder' : 'File' })
      );
      results.appendChild(row);
    });
  }

  async function runSearch() {
    const query = input.value.trim();
    if (!query) {
      status.textContent = 'Enter a file or folder name to search for.';
      input.focus();
      return;
    }
    if (searching) return;
    searching = true;
    searched = false;
    const currentRequest = ++requestId;
    searchButton.disabled = true;
    items = [];
    renderResults();
    status.textContent = 'Searching ' + directory + '…';
    try {
      const data = await api.get(
        '/api/files/search?path=' +
          encodeURIComponent(directory) +
          '&q=' +
          encodeURIComponent(query) +
          '&hidden=' +
          (searchHiddenToggle.checked ? '1' : '0')
      );
      if (currentRequest !== requestId) return;
      items = Array.isArray(data.entries) ? data.entries : [];
      searched = true;
      status.textContent = data.truncated
        ? 'Showing the first ' + items.length + ' matches. Refine your search for fewer results.'
        : items.length + (items.length === 1 ? ' match' : ' matches') + ' in ' + directory;
      renderResults();
    } catch (err) {
      if (currentRequest !== requestId) return;
      items = [];
      renderResults();
      status.textContent = err.message;
    } finally {
      if (currentRequest === requestId) {
        searching = false;
        searchButton.disabled = false;
      }
    }
  }

  const searchButton = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => runSearch() }, 'Search');
  const searchHiddenToggle = h('input', {
    type: 'checkbox',
    checked: showHidden,
    'aria-label': 'Include hidden files and folders'
  });
  const body = h(
    'div',
    { class: 'file-search' },
    h(
      'div',
      { class: 'file-search-form' },
      input,
      h('label', { class: 'check', style: { fontSize: '12px' } }, searchHiddenToggle, h('span', { text: 'Hidden' })),
      searchButton
    ),
    status,
    results
  );
  const dialog = modal({
    title: 'Search files',
    body,
    wide: true,
    actions: [
      { label: 'Close', value: null },
      {
        label: 'Open',
        variant: 'primary',
        onClick: (close) => {
          if (!selected) return false;
          const item = selected;
          close(null);
          openSearchResult(item);
          return false;
        }
      }
    ]
  });
  input.focus();
  return dialog;
}

function setPathEditing(editing) {
  if (!host) return;
  const input = host.querySelector('.path-input');
  if (!input) return;
  const visibility = [
    ['.crumbs', editing],
    ['.path-input', !editing],
    ['.path-edit', editing],
    ['.path-save', !editing],
    ['.path-cancel', !editing]
  ];
  for (const [selector, hidden] of visibility) {
    const element = host.querySelector(selector);
    if (element) element.classList.toggle('hidden', hidden);
  }
  input.value = cwd;
  if (editing) {
    input.focus();
    input.select();
  } else if (document.activeElement === input) {
    input.blur();
  }
}

function submitPathEdit() {
  if (!host) return;
  const input = host.querySelector('.path-input');
  const value = input ? input.value.trim() : '';
  if (!value) return;
  if (value === cwd) {
    setPathEditing(false);
    return;
  }
  navigate(value);
}

async function navigate(path) {
  if (!path) return;
  setPathEditing(false);
  await load(path, { type: 'push' });
}

async function refresh() {
  await load(cwd);
}

async function load(path, historyAction = null) {
  const tab = currentTab();
  if (!tab || !path) return;
  const requestId = tab.requestId + 1;
  tab.requestId = requestId;
  tab.loading = true;
  if (activeTabId === tab.id) renderHistoryButtons();
  const previousSelection = activeTabId === tab.id ? selection : tab.selection;
  try {
    const data = await api.get('/api/files/list?path=' + encodeURIComponent(path || '') + '&hidden=' + (showHidden ? '1' : '0'));
    if (!tabs.includes(tab) || tab.requestId !== requestId) return;
    const nextEntries = Array.isArray(data.entries) ? data.entries : [];
    const resolvedPath = data.path || path || '/';
    if (historyAction && historyAction.type === 'push') {
      if (resolvedPath !== tab.history[tab.historyIndex]) {
        let history = tab.history.slice(0, tab.historyIndex + 1);
        history.push(resolvedPath);
        if (history.length > HISTORY_LIMIT) history = history.slice(history.length - HISTORY_LIMIT);
        tab.history = history;
        tab.historyIndex = history.length - 1;
      }
    } else if (historyAction && historyAction.type === 'index') {
      if (historyAction.index >= 0 && historyAction.index < tab.history.length) {
        tab.historyIndex = historyAction.index;
        tab.history[historyAction.index] = resolvedPath;
      }
    } else {
      tab.history[tab.historyIndex] = resolvedPath;
    }
    tab.cwd = resolvedPath;
    tab.title = tabTitle(tab.cwd);
    tab.entries = nextEntries;
    tab.selection = new Set(Array.from(previousSelection || []).filter((name) => nextEntries.some((entry) => entry.name === name)));
    tab.lastIndex = -1;
    tab.loaded = true;
    if (activeTabId === tab.id) {
      restoreTab(tab);
      renderAll();
    } else {
      renderFileTabs();
    }
    savePrefs();
  } catch (err) {
    if (activeTabId === tab.id && tab.requestId === requestId) toast(err.message, 'danger');
  } finally {
    if (tab.requestId === requestId) {
      tab.loading = false;
      if (activeTabId === tab.id) renderHistoryButtons();
    }
  }
}

function glyph(entry) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'glyph ' + (entry.type === 'dir' ? 'dir' : entry.type === 'link' ? 'link' : 'file'));
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  if (entry.type === 'dir') {
    path.setAttribute('d', 'M3 6h6l2 2h10v10H3z');
  } else if (entry.type === 'link') {
    path.setAttribute('d', 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7L11 7M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7L13 17');
  } else {
    path.setAttribute('d', 'M6 3h8l4 4v14H6zM14 3v4h4');
  }
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  return svg;
}

function renderCrumbs() {
  if (!host) return;
  const crumbs = host.querySelector('.crumbs');
  crumbs.textContent = '';
  const parts = cwd.split('/').filter(Boolean);
  crumbs.appendChild(h('button', { class: 'crumb', type: 'button', onclick: () => navigate('/') }, '/'));
  let acc = '';
  parts.forEach((part, index) => {
    acc += '/' + part;
    const target = acc;
    if (index > 0) crumbs.appendChild(h('span', { class: 'crumb-sep', text: '/' }));
    crumbs.appendChild(h('button', { class: 'crumb', type: 'button', onclick: () => navigate(target) }, part));
  });
  const input = host.querySelector('.path-input');
  if (input && document.activeElement !== input) input.value = cwd;
}

function updateSelectionStyles() {
  if (!host) return;
  const rows = host.querySelectorAll('.files-list tbody tr[data-name]');
  for (const row of rows) row.classList.toggle('selected', selection.has(row.dataset.name));
}

function renderRows() {
  if (!host) return;
  const body = host.querySelector('.files-list tbody');
  body.textContent = '';
  const parent = h(
    'tr',
    {
      class: 'parent-row',
      dataset: { parent: 'true' },
      ondblclick: () => navigate(parentOf(cwd)),
      oncontextmenu: (event) => {
        event.preventDefault();
        event.stopPropagation();
        selection = new Set();
        updateSelectionStyles();
        openMenu(event, null, parentOf(cwd));
      }
    },
    h(
      'td',
      {},
      h('div', { class: 'fname' }, glyph({ type: 'dir' }), h('span', { class: 'label', text: '..' }))
    ),
    h('td', { class: 'num mono', text: '\u2014' }),
    h('td', { class: 'mono muted', text: '\u2014' }),
    h('td', { class: 'mono muted', text: '\u2014' }),
    h('td', { class: 'mono muted', text: '\u2014' })
  );
  body.appendChild(parent);
  if (!entries.length) {
    body.appendChild(h('tr', {}, h('td', { colspan: '5', class: 'empty', text: 'Empty directory' })));
    return;
  }
  entries.forEach((entry, index) => {
    const row = h(
      'tr',
      {
        class: selection.has(entry.name) ? 'selected' : '',
        dataset: { name: entry.name },
        onclick: (event) => {
          if (event.shiftKey && lastIndex >= 0) {
            const start = Math.min(lastIndex, index);
            const end = Math.max(lastIndex, index);
            if (!event.ctrlKey && !event.metaKey) selection = new Set();
            for (let i = start; i <= end; i += 1) selection.add(entries[i].name);
          } else if (event.ctrlKey || event.metaKey) {
            if (selection.has(entry.name)) selection.delete(entry.name);
            else selection.add(entry.name);
            lastIndex = index;
          } else {
            selection = new Set([entry.name]);
            lastIndex = index;
          }
          updateSelectionStyles();
        },
        ondblclick: () => openEntry(entry),
        oncontextmenu: (event) => {
          event.preventDefault();
          openMenu(event, entry);
        }
      },
      h(
        'td',
        {},
        h(
          'div',
          { class: 'fname' },
          glyph(entry),
          h('span', { class: 'label', title: entry.name, text: entry.name }),
          entry.type === 'link' ? h('span', { class: 'muted', text: '\u2192 ' + (entry.link_target || '?') }) : null
        )
      ),
      h('td', { class: 'num mono', text: entry.type === 'dir' ? '\u2014' : formatBytes(entry.size) }),
      h('td', { class: 'mono muted', text: formatDate(entry.mtime) }),
      h('td', { class: 'mono muted', text: (entry.mode || '') + ' ' + (entry.octal || '') }),
      h('td', { class: 'mono muted', text: (entry.owner || '') + ':' + (entry.group || '') })
    );
    body.appendChild(row);
  });
}

function renderUploads() {
  if (!host) return;
  const panel = host.querySelector('.uploads');
  if (!panel) return;
  panel.textContent = '';
  panel.classList.toggle('hidden', !uploads.length);
  for (const item of uploads) {
    const fill = h('div', { class: 'progress-fill ' + (item.error ? 'danger' : item.done ? 'ok' : 'info'), style: { width: item.percent + '%' } });
    panel.appendChild(
      h(
        'div',
        { class: 'upload-row' },
        h('span', { class: 'name', title: item.name, text: item.name }),
        h('div', { class: 'progress' }, fill),
        h('span', { class: 'muted', text: item.error ? 'failed' : item.done ? 'done' : item.percent + '%' })
      )
    );
  }
}

function renderAll() {
  captureActiveTab();
  renderFileTabs();
  renderHistoryButtons();
  renderCrumbs();
  renderRows();
  renderUploads();
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  for (const file of files) {
    const item = { name: file.name, percent: 0, done: false, error: false };
    uploads.push(item);
    renderUploads();
    const ok = await uploadOne(file, item, false);
    if (!ok) continue;
  }
  uploads = uploads.filter((item) => !item.done);
  renderUploads();
  await refresh();
}

async function uploadOne(file, item, overwrite) {
  const url = '/api/files/upload?dir=' + encodeURIComponent(cwd) + '&name=' + encodeURIComponent(file.name) + '&overwrite=' + (overwrite ? '1' : '0');
  try {
    await api.put(url, file, (loaded, total) => {
      item.percent = total ? Math.round((loaded / total) * 100) : 100;
      renderUploads();
    });
    item.percent = 100;
    item.done = true;
    renderUploads();
    toast('Uploaded ' + file.name, 'ok');
    return true;
  } catch (err) {
    const message = err && err.message ? err.message : 'upload failed';
    if (!overwrite && /exist/i.test(message)) {
      const ok = await confirmDialog('"' + file.name + '" already exists in this directory. Overwrite it?', {
        danger: true,
        title: 'Overwrite file',
        confirmLabel: 'Overwrite'
      });
      if (ok) return uploadOne(file, item, true);
      item.error = true;
      renderUploads();
      return false;
    }
    item.error = true;
    renderUploads();
    toast(message, 'danger');
    return false;
  }
}

async function newFolder() {
  const value = await promptDialog('New folder', 'Folder name', '');
  if (value === null) return;
  const name = value.trim();
  if (!name) return;
  try {
    await api.post('/api/files/mkdir', { path: join(cwd, name) });
    toast('Folder created', 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

async function newFile() {
  const value = await promptDialog('New file', 'File name', '');
  if (value === null) return;
  const name = value.trim();
  if (!name) return;
  try {
    await api.post('/api/files/touch', { path: join(cwd, name) });
    toast('File created', 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

function closeEditor(force) {
  if (!editor) return;
  if (!force && editor.dirty) {
    confirmDialog('Discard unsaved changes to "' + editor.name + '"?', {
      danger: true,
      title: 'Unsaved changes',
      confirmLabel: 'Discard'
    }).then((ok) => {
      if (ok) closeEditor(true);
    });
    return;
  }
  editor.overlay.remove();
  editor = null;
}

async function editFile(path) {
  let data;
  try {
    data = await api.get('/api/files/read?path=' + encodeURIComponent(path));
  } catch (err) {
    const message = err && err.message ? err.message : 'cannot open file';
    const useNano = await confirmDialog(message + '\n\nOpen it in nano instead?', {
      title: 'Cannot open in editor',
      confirmLabel: 'Edit with nano'
    });
    if (useNano) nanoFile(path);
    return;
  }
  const name = path.split('/').pop() || path;
  const area = h('textarea', { class: 'editor-area', spellcheck: 'false', wrap: 'off' });
  area.value = data.content || '';
  const status = h('span', { text: '1:1' });
  const dirtyLabel = h('span', { class: 'muted', text: 'saved' });
  const saveBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Save');
  const closeBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Close');
  const overlay = h(
    'div',
    { class: 'editor-overlay' },
    h(
      'div',
      { class: 'editor' },
      h(
        'div',
        { class: 'editor-head' },
        h('span', { class: 'editor-title', text: path }),
        dirtyLabel,
        saveBtn,
        closeBtn
      ),
      area,
      h('div', { class: 'editor-foot' }, status, h('span', { text: 'Ctrl+S to save \u00b7 Esc to close' }))
    )
  );
  editor = { overlay, dirty: false, name, path, area };

  const updateStatus = () => {
    const upto = area.value.slice(0, area.selectionStart);
    const lines = upto.split('\n');
    status.textContent = lines.length + ':' + (lines[lines.length - 1].length + 1);
  };

  const save = async () => {
    saveBtn.disabled = true;
    try {
      await api.post('/api/files/write', { path, content: area.value });
      editor.dirty = false;
      dirtyLabel.textContent = 'saved';
      dirtyLabel.className = 'muted';
      toast('Saved ' + name, 'ok');
      await refresh();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      saveBtn.disabled = false;
    }
  };

  area.addEventListener('input', () => {
    if (editor) {
      editor.dirty = true;
      dirtyLabel.textContent = 'unsaved';
      dirtyLabel.className = 'warn-text';
    }
    updateStatus();
  });
  area.addEventListener('click', updateStatus);
  area.addEventListener('keyup', updateStatus);
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = area.selectionStart;
      const end = area.selectionEnd;
      area.value = area.value.slice(0, start) + '\t' + area.value.slice(end);
      area.selectionStart = start + 1;
      area.selectionEnd = start + 1;
      area.dispatchEvent(new Event('input'));
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeEditor(false);
    }
  });
  saveBtn.addEventListener('click', save);
  closeBtn.addEventListener('click', () => closeEditor(false));
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) closeEditor(false);
  });
  document.body.appendChild(overlay);
  area.focus();
  updateStatus();
}

// SVG definitions from https://lucide.dev (ISC license).
const TOOLBAR_ICONS = {
  'folder-plus': [
    ['path', { d: 'M12 10v6' }],
    ['path', { d: 'M9 13h6' }],
    ['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]
  ],
  'file-plus': [
    ['path', { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' }],
    ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }],
    ['path', { d: 'M9 15h6' }],
    ['path', { d: 'M12 18v-6' }]
  ],
  upload: [
    ['path', { d: 'M12 3v12' }],
    ['path', { d: 'm17 8-5-5-5 5' }],
    ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }]
  ],
  'arrow-left': [
    ['path', { d: 'm12 19-7-7 7-7' }],
    ['path', { d: 'M19 12H5' }]
  ],
  'arrow-right': [
    ['path', { d: 'M5 12h14' }],
    ['path', { d: 'm12 5 7 7-7 7' }]
  ],
  home: [
    ['path', { d: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8' }],
    ['path', { d: 'M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]
  ],
  'refresh-cw': [
    ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
    ['path', { d: 'M21 3v5h-5' }],
    ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
    ['path', { d: 'M8 16H3v5' }]
  ],
  plus: [
    ['path', { d: 'M5 12h14' }],
    ['path', { d: 'M12 5v14' }]
  ],
  'arrow-big-right': [
    ['path', { d: 'M13.207 19.793a.707.707 0 0 1-1.207-.5V16a1 1 0 0 0-1-1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h6a1 1 0 0 0 1-1V4.707a.707.707 0 0 1 1.207-.5l6.94 6.94a1.207 1.207 0 0 1 0 1.707z' }]
  ],
  'square-terminal': [
    ['path', { d: 'm7 11 2-2-2-2' }],
    ['path', { d: 'M11 13h4' }],
    ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2', ry: '2' }]
  ],
  'square-pen': [
    ['path', { d: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' }],
    ['path', { d: 'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z' }]
  ],
  search: [
    ['circle', { cx: '11', cy: '11', r: '8' }],
    ['path', { d: 'm21 21-4.3-4.3' }]
  ],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  x: [
    ['path', { d: 'M18 6 6 18' }],
    ['path', { d: 'm6 6 12 12' }]
  ]
};

function lucideIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const [tag, attrs] of TOOLBAR_ICONS[name]) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.appendChild(node);
  }
  return svg;
}

function toolbarButton({ className = '', label, iconName, onClick, disabled = false }) {
  const iconNames = Array.isArray(iconName) ? iconName : [iconName];
  return h(
    'button',
    {
      class:
        'btn btn-sm files-toolbar-button' +
        (iconNames.length > 1 ? ' files-toolbar-button-dual' : '') +
        ' ' +
        className,
      type: 'button',
      title: label,
      'aria-label': label,
      disabled,
      onclick: onClick
    },
    ...iconNames.map((name) => lucideIcon(name))
  );
}

export async function mount(container, ctx) {
  ctxRef = ctx;
  mounted = true;
  host = h('div', { class: 'pane pane-files' });
  const fileTabs = h('div', { class: 'file-tabs', 'aria-label': 'File tabs' });
  const crumbs = h('div', { class: 'crumbs' });
  const pathInput = h('input', {
    class: 'path-input hidden',
    type: 'text',
    spellcheck: 'false',
    'aria-label': 'Path',
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitPathEdit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setPathEditing(false);
        const editButton = host.querySelector('.path-edit');
        if (editButton) editButton.focus();
      }
    }
  });
  const hiddenToggle = h('input', {
    type: 'checkbox',
    checked: showHidden,
    onchange: () => {
      showHidden = hiddenToggle.checked;
      savePrefs();
      refresh();
    }
  });
  const fileInput = h('input', {
    type: 'file',
    multiple: true,
    style: { display: 'none' },
    onchange: () => {
      uploadFiles(fileInput.files);
      fileInput.value = '';
    }
  });
  const toolbar = h(
    'div',
    { class: 'files-toolbar' },
    h(
      'div',
      { class: 'files-toolbar-row files-toolbar-primary' },
      toolbarButton({
        label: 'Home directory',
        iconName: 'home',
        onClick: () => navigate((ctx.me && ctx.me.home) || '/')
      }),
      crumbs,
      pathInput,
      toolbarButton({
        className: 'path-edit',
        label: 'Edit path',
        iconName: 'square-pen',
        onClick: () => setPathEditing(true)
      }),
      toolbarButton({
        className: 'file-search-button',
        label: 'Search files',
        iconName: 'search',
        onClick: () => searchFiles()
      }),
      toolbarButton({
        className: 'path-save hidden',
        label: 'Confirm path',
        iconName: 'check',
        onClick: () => submitPathEdit()
      }),
      toolbarButton({
        className: 'path-cancel hidden',
        label: 'Cancel path editing',
        iconName: 'x',
        onClick: () => setPathEditing(false)
      }),
      toolbarButton({
        label: 'Open a new terminal in this directory',
        iconName: ['square-terminal', 'plus'],
        onClick: () => openTerminalHere(cwd)
      }),
      toolbarButton({
        label: 'Move the active terminal to this directory',
        iconName: ['square-terminal', 'arrow-big-right'],
        onClick: () => moveTerminalHere(cwd)
      })
    ),
    h(
      'div',
      { class: 'files-toolbar-row files-toolbar-secondary' },
      toolbarButton({
        className: 'history-previous',
        label: 'Previous directory',
        iconName: 'arrow-left',
        disabled: true,
        onClick: () => goHistory(-1)
      }),
      toolbarButton({
        className: 'history-next',
        label: 'Next directory',
        iconName: 'arrow-right',
        disabled: true,
        onClick: () => goHistory(1)
      }),
      toolbarButton({ label: 'Refresh', iconName: 'refresh-cw', onClick: () => refresh() }),
      toolbarButton({ label: 'New folder', iconName: 'folder-plus', onClick: () => newFolder() }),
      toolbarButton({ label: 'New file', iconName: 'file-plus', onClick: () => newFile() }),
      toolbarButton({ label: 'Upload files', iconName: 'upload', onClick: () => fileInput.click() }),
      h('label', { class: 'check', style: { fontSize: '12px' } }, hiddenToggle, h('span', { text: 'Hidden' }))
    ),
    fileInput
  );
  const body = h('tbody');
  const list = h(
    'div',
    { class: 'files-list', tabindex: '0' },
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { text: 'Name' }),
          h('th', { class: 'num', text: 'Size' }),
          h('th', { text: 'Modified' }),
          h('th', { text: 'Mode' }),
          h('th', { text: 'Owner' })
        )
      ),
      body
    )
  );
  const uploadPanel = h('div', { class: 'uploads hidden' });
  list.addEventListener('mousedown', () => list.focus());
  host.appendChild(fileTabs);
  host.appendChild(toolbar);
  host.appendChild(list);
  host.appendChild(uploadPanel);
  container.appendChild(host);

  host.addEventListener('contextmenu', (event) => {
    if (event.target.closest('tr[data-name], tr[data-parent="true"]')) return;
    event.preventDefault();
    selection = new Set();
    updateSelectionStyles();
    openMenu(event, null);
  });
  host.addEventListener('dragover', (event) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
    event.preventDefault();
    host.classList.add('drag-over');
  });
  host.addEventListener('dragleave', (event) => {
    if (event.target === host) host.classList.remove('drag-over');
  });
  host.addEventListener('drop', (event) => {
    event.preventDefault();
    host.classList.remove('drag-over');
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
      uploadFiles(event.dataTransfer.files);
    }
  });
  document.addEventListener('mousedown', onDocumentDown);
  document.addEventListener('keydown', onDocumentKey);

  let prefs = {};
  try {
    prefs = await api.get('/api/prefs');
  } catch (err) {
    prefs = {};
  }
  if (!mounted) return;
  const saved = prefs && prefs.files ? prefs.files : {};
  showHidden = saved.show_hidden === true;
  hiddenToggle.checked = showHidden;
  const home = (ctx.me && ctx.me.home) || '/';
  const start = typeof saved.cwd === 'string' && saved.cwd ? saved.cwd : home;
  const savedTabs = Array.isArray(saved.tabs) ? saved.tabs : [];
  const seen = new Set();
  tabs = [];
  for (const item of savedTabs) {
    if (!item || typeof item.cwd !== 'string' || !item.cwd) continue;
    let id = typeof item.id === 'string' && /^[a-z0-9]{1,16}$/.test(item.id) ? item.id : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    const tab = makeTab(item.cwd, id);
    const savedHistory = Array.isArray(item.history)
      ? item.history.filter((path) => typeof path === 'string' && path).slice(-HISTORY_LIMIT)
      : [];
    if (savedHistory.length) {
      tab.history = savedHistory;
      tab.historyIndex = Number.isInteger(item.history_index)
        ? Math.max(0, Math.min(savedHistory.length - 1, item.history_index))
        : savedHistory.length - 1;
      tab.history[tab.historyIndex] = item.cwd;
    }
    tabs.push(tab);
  }
  if (!tabs.length) tabs.push(makeTab(start));
  activeTabId = saved.active && tabs.some((tab) => tab.id === saved.active) ? saved.active : tabs[0].id;
  restoreTab(currentTab());
  renderAll();
  await load(cwd || start);
}

export function unmount() {
  mounted = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  closeMenu();
  document.removeEventListener('mousedown', onDocumentDown);
  document.removeEventListener('keydown', onDocumentKey);
}

export function destroy() {
  unmount();
  if (editor) {
    editor.overlay.remove();
    editor = null;
  }
  if (host && host.parentNode) host.remove();
  host = null;
  entries = [];
  selection = new Set();
  uploads = [];
  tabs = [];
  activeTabId = null;
  cwd = '';
}

export function focus() {
  if (host) host.querySelector('.files-list').focus();
}
