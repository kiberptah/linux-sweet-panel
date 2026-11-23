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
          tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title, cwd: tab.cwd }))
        }
      })
      .catch((err) => toast(err.message, 'danger'));
  }, 300);
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
          onclick: () => selectFileTab(tab.id)
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

async function navigate(path) {
  if (!path) return;
  await load(path);
}

async function refresh() {
  await load(cwd);
}

async function load(path) {
  const tab = currentTab();
  if (!tab || !path) return;
  const requestId = tab.requestId + 1;
  tab.requestId = requestId;
  tab.loading = true;
  const previousSelection = activeTabId === tab.id ? selection : tab.selection;
  try {
    const data = await api.get('/api/files/list?path=' + encodeURIComponent(path || '') + '&hidden=' + (showHidden ? '1' : '0'));
    if (!tabs.includes(tab) || tab.requestId !== requestId) return;
    const nextEntries = Array.isArray(data.entries) ? data.entries : [];
    tab.cwd = data.path || path || '/';
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
    if (tab.requestId === requestId) tab.loading = false;
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

export async function mount(container, ctx) {
  ctxRef = ctx;
  mounted = true;
  host = h('div', { class: 'pane pane-files' });
  const fileTabs = h('div', { class: 'file-tabs', 'aria-label': 'File tabs' });
  const crumbs = h('div', { class: 'crumbs' });
  const pathInput = h('input', {
    class: 'path-input',
    type: 'text',
    spellcheck: 'false',
    'aria-label': 'Path',
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const value = pathInput.value.trim();
        if (value) navigate(value);
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
    h('button', { class: 'btn btn-sm', type: 'button', title: 'Up one level', onclick: () => navigate(parentOf(cwd)) }, 'Up'),
    h('button', { class: 'btn btn-sm', type: 'button', title: 'Home directory', onclick: () => navigate((ctx.me && ctx.me.home) || '/') }, 'Home'),
    h('button', { class: 'btn btn-sm', type: 'button', title: 'Refresh', onclick: () => refresh() }, 'Refresh'),
    h('button', { class: 'btn btn-sm', type: 'button', title: 'Open a new terminal in this directory', onclick: () => openTerminalHere(cwd) }, 'Open >_'),
    h('button', { class: 'btn btn-sm', type: 'button', title: 'Move the active terminal to this directory', onclick: () => moveTerminalHere(cwd) }, 'Move >_'),
    crumbs,
    pathInput,
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => newFolder() }, 'New Folder'),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => newFile() }, 'New File'),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => fileInput.click() }, 'Upload'),
    h('label', { class: 'check', style: { fontSize: '12px' } }, hiddenToggle, h('span', { text: 'Hidden' })),
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
    tabs.push(makeTab(item.cwd, id));
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
