import { api } from './api.js';
import { h, toast } from './ui.js';
import * as terminalPane from './terminal.js';
import * as filesPane from './files.js';

const NARROW = 800;

let host = null;
let ctxRef = null;
let built = false;
let mounted = false;
let mode = 'split';
let ratio = 0.5;
let focusPane = 'terminal';
let saveTimer = null;
let onResize = null;
let dragging = false;

function narrow() {
  return window.innerWidth < NARROW;
}

function effectiveMode() {
  return narrow() ? 'tabs' : mode;
}

function savePrefs() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    api
      .post('/api/prefs', { workspace: { mode, ratio, focus: focusPane } })
      .catch((err) => toast(err.message, 'danger'));
  }, 250);
}

function applyLayout() {
  if (!host) return;
  const panes = host.querySelector('.panes');
  const termPane = host.querySelector('.pane-terminal');
  const filesEl = host.querySelector('.pane-files');
  const divider = host.querySelector('.divider');
  const current = effectiveMode();
  panes.classList.toggle('tabs-mode', current === 'tabs');
  if (current === 'tabs') {
    termPane.style.flex = '';
    filesEl.style.flex = '';
    termPane.classList.toggle('hidden', focusPane !== 'terminal');
    filesEl.classList.toggle('hidden', focusPane !== 'files');
  } else {
    termPane.classList.remove('hidden');
    filesEl.classList.remove('hidden');
    termPane.style.flex = '0 0 ' + (ratio * 100).toFixed(2) + '%';
    filesEl.style.flex = '1 1 auto';
  }
  divider.classList.toggle('hidden', current === 'tabs');
  const segButtons = host.querySelectorAll('.seg button');
  for (const button of segButtons) {
    button.classList.toggle('active', button.dataset.mode === current);
  }
  const focusButtons = host.querySelectorAll('.seg-focus button');
  for (const button of focusButtons) {
    button.classList.toggle('active', button.dataset.focus === focusPane);
  }
  const focusSeg = host.querySelector('.seg-focus');
  focusSeg.classList.toggle('hidden', current !== 'tabs');
  terminalPane.refit();
}

function setMode(next) {
  mode = next === 'tabs' ? 'tabs' : 'split';
  applyLayout();
  savePrefs();
}

function setFocus(pane) {
  focusPane = pane === 'files' ? 'files' : 'terminal';
  applyLayout();
  savePrefs();
  if (focusPane === 'terminal') terminalPane.focus();
  else filesPane.focus();
}

function onDividerDown(event) {
  if (effectiveMode() !== 'split' || !host) return;
  event.preventDefault();
  dragging = true;
  const panes = host.querySelector('.panes');
  const move = (moveEvent) => {
    if (!dragging) return;
    const rect = panes.getBoundingClientRect();
    if (!rect.width) return;
    const next = (moveEvent.clientX - rect.left) / rect.width;
    ratio = Math.max(0.2, Math.min(0.8, next));
    applyLayout();
  };
  const up = () => {
    dragging = false;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.body.style.cursor = '';
    savePrefs();
  };
  document.body.style.cursor = 'col-resize';
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function build() {
  host.textContent = '';
  const seg = h(
    'div',
    { class: 'seg' },
    h('button', { type: 'button', dataset: { mode: 'split' }, onclick: () => setMode('split') }, 'Split'),
    h('button', { type: 'button', dataset: { mode: 'tabs' }, onclick: () => setMode('tabs') }, 'Tabs')
  );
  const focusSeg = h(
    'div',
    { class: 'seg seg-focus' },
    h('button', { type: 'button', dataset: { focus: 'terminal' }, onclick: () => setFocus('terminal') }, 'Terminal'),
    h('button', { type: 'button', dataset: { focus: 'files' }, onclick: () => setFocus('files') }, 'Files')
  );
  const bar = h(
    'div',
    { class: 'workspace-bar' },
    h('div', { class: 'card-title', text: 'Workspace' }),
    seg,
    focusSeg,
    h('div', { class: 'spacer', style: { flex: '1' } })
  );
  const panes = h('div', { class: 'panes' });
  const divider = h('div', { class: 'divider', onpointerdown: onDividerDown });
  host.appendChild(h('div', { class: 'workspace' }, bar, panes));
  panes.appendChild(divider);
  terminalPane.mount(panes, ctxRef);
  filesPane.mount(panes, {
    me: ctxRef.me,
    openTerminal: (command) => {
      setFocus('terminal');
      terminalPane.openInTerminal(command);
    }
  });
  const termEl = panes.querySelector('.pane-terminal');
  const filesEl = panes.querySelector('.pane-files');
  if (termEl && filesEl) panes.insertBefore(divider, filesEl);
  built = true;
}

export async function mount(container, ctx) {
  ctxRef = ctx;
  mounted = true;
  if (!built) {
    host = h('div', { class: 'workspace-root' });
    container.appendChild(host);
    let prefs = {};
    try {
      prefs = await api.get('/api/prefs');
    } catch (err) {
      prefs = {};
    }
    const saved = prefs && prefs.workspace ? prefs.workspace : {};
    mode = saved.mode === 'tabs' ? 'tabs' : 'split';
    ratio = typeof saved.ratio === 'number' && saved.ratio >= 0.2 && saved.ratio <= 0.8 ? saved.ratio : 0.5;
    focusPane = saved.focus === 'files' ? 'files' : 'terminal';
    if (!mounted) return;
    build();
    onResize = () => applyLayout();
    window.addEventListener('resize', onResize);
  } else if (host && host.parentNode !== container) {
    container.appendChild(host);
  }
  applyLayout();
}

export function unmount() {
  mounted = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (onResize) {
    window.removeEventListener('resize', onResize);
    onResize = null;
  }
}

export function destroy() {
  unmount();
  terminalPane.destroy();
  filesPane.destroy();
  if (host && host.parentNode) host.remove();
  host = null;
  built = false;
}

export function focus(pane) {
  if (!mounted) return;
  setFocus(pane);
}

export function openTerminal(command) {
  if (!mounted) return;
  setFocus('terminal');
  terminalPane.openInTerminal(command);
}
