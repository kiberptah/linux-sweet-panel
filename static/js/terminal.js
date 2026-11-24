import { api } from './api.js';
import { h, toast, modal, promptDialog, confirmDialog } from './ui.js';

const THEME = {
  background: '#14151c',
  foreground: '#e6e6ef',
  cursor: '#b9a8ff',
  cursorAccent: '#14151c',
  selectionBackground: 'rgba(185,168,255,.3)',
  black: '#1c1e27',
  red: '#ff9fb6',
  green: '#95e6c0',
  yellow: '#ffc69a',
  blue: '#9fd3ff',
  magenta: '#b9a8ff',
  cyan: '#9fe8e0',
  white: '#e6e6ef',
  brightBlack: '#6f7285',
  brightRed: '#ffc0cf',
  brightGreen: '#bdf3dd',
  brightYellow: '#ffdcbd',
  brightBlue: '#c4e6ff',
  brightMagenta: '#d6ccff',
  brightCyan: '#c6f4ef',
  brightWhite: '#ffffff'
};

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const BACKOFF = [1000, 2000, 5000, 10000];

let host = null;
let tabs = [];
let active = null;
let saveTimer = null;
let mounted = false;
let menu = null;
let menuSerial = 0;

function closeMenu() {
  menuSerial += 1;
  if (menu) {
    menu.remove();
    menu = null;
  }
}

function onDocumentDown(event) {
  if (menu && !menu.contains(event.target)) closeMenu();
}

function onDocumentKey(event) {
  if (event.key === 'Escape' && menu) {
    event.preventDefault();
    closeMenu();
  }
}

async function copyText(text) {
  if (!text) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = h('textarea', { style: { position: 'fixed', left: '-1000px', top: '0' } });
      area.value = text;
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      if (!copied) throw new Error('copy failed');
    }
  } catch (err) {
    toast('Could not copy the selection', 'danger');
  }
}

async function pasteText(tab) {
  let text = null;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      text = null;
    }
  }
  if (text === null) text = await promptDialog('Paste into terminal', 'Text to paste', '');
  if (text) sendInput(tab, text);
}

function terminalLineAt(tab, event) {
  try {
    if (!tab.term || !tab.term.element || !tab.term.buffer) return '';
    const screen = tab.term.element.querySelector('.xterm-screen');
    const buffer = tab.term.buffer.active;
    if (!screen || !buffer || !tab.term.rows) return '';
    const rect = screen.getBoundingClientRect();
    if (!rect.height || event.clientY < rect.top || event.clientY >= rect.bottom) return '';
    const row = Math.max(0, Math.min(tab.term.rows - 1, Math.floor(((event.clientY - rect.top) / rect.height) * tab.term.rows)));
    const line = buffer.getLine(buffer.viewportY + row);
    return line ? line.translateToString(true) : '';
  } catch (err) {
    return '';
  }
}

async function runTerminalAction(tab, action, text) {
  const payload = { id: tab.id, action };
  if (text !== undefined) payload.text = text;
  try {
    await api.post('/api/terminal/action', payload);
    if (tab.term) tab.term.focus();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

async function openTerminalMenu(event, tab) {
  closeMenu();
  const serial = ++menuSerial;
  if (!tab) return;
  if (tab.id !== active) selectTab(tab.id);
  const selected = tab.term && tab.term.hasSelection() ? tab.term.getSelection() : '';
  const line = terminalLineAt(tab, event);
  // Let tmux select the clicked pane before the state request reaches the server.
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (serial !== menuSerial || !mounted || !tabs.includes(tab)) return;
  let state = null;
  try {
    state = await api.get('/api/terminal/pane-state?id=' + encodeURIComponent(tab.id));
  } catch (err) {
    toast(err.message, 'danger');
  }
  if (serial !== menuSerial || !mounted || !tabs.includes(tab)) return;
  const unavailable = !state;
  const inMode = state && state.in_mode;
  const multiplePanes = state && state.panes > 1;
  const items = [];
  if (inMode) {
    items.push(
      { label: 'Go to top', action: () => runTerminalAction(tab, 'history-top') },
      { label: 'Go to bottom', action: () => runTerminalAction(tab, 'history-bottom') },
      { sep: true }
    );
  }
  items.push(
    { label: 'Copy selection', disabled: !selected, action: () => copyText(selected) },
    { label: 'Copy line', disabled: !line, action: () => copyText(line) },
    { label: 'Paste', disabled: inMode === true, action: () => pasteText(tab) },
    { sep: true },
    {
      label: 'Search selection',
      disabled: unavailable || !selected,
      action: () => runTerminalAction(tab, 'search-selection', selected)
    },
    {
      label: 'Type selection',
      disabled: unavailable || !selected,
      action: () => runTerminalAction(tab, 'type-selection', selected)
    },
    { sep: true },
    { label: 'New terminal tab', action: () => addTab() },
    { label: 'Horizontal split', disabled: unavailable, action: () => runTerminalAction(tab, 'split-horizontal') },
    { label: 'Vertical split', disabled: unavailable, action: () => runTerminalAction(tab, 'split-vertical') },
    { sep: true },
    { label: 'Swap up', disabled: multiplePanes !== true, action: () => runTerminalAction(tab, 'swap-up') },
    { label: 'Swap down', disabled: multiplePanes !== true, action: () => runTerminalAction(tab, 'swap-down') },
    {
      label: 'Swap marked',
      disabled: unavailable || !state.marked_set,
      action: () => runTerminalAction(tab, 'swap-marked')
    },
    { sep: true },
    { label: 'Kill pane', disabled: unavailable, danger: true, action: () => runTerminalAction(tab, 'kill-pane') },
    { label: 'Respawn pane', disabled: unavailable, action: () => runTerminalAction(tab, 'respawn-pane') },
    {
      label: state && state.marked ? 'Unmark pane' : 'Mark pane',
      disabled: unavailable,
      action: () => runTerminalAction(tab, 'toggle-mark')
    },
    {
      label: state && state.zoomed ? 'Unzoom pane' : 'Zoom pane',
      disabled: multiplePanes !== true,
      action: () => runTerminalAction(tab, 'toggle-zoom')
    }
  );
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

function newId() {
  let id = '';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 8; i += 1) id += ID_CHARS[bytes[i] % ID_CHARS.length];
  return id;
}

function savePrefs() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    api
      .post('/api/prefs', { terminal: { tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title })), active } })
      .catch((err) => toast(err.message, 'danger'));
  }, 250);
}

function wsUrl(tab) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const cols = tab.fit && tab.term ? tab.term.cols : 80;
  const rows = tab.fit && tab.term ? tab.term.rows : 24;
  return scheme + '//' + location.host + '/ws/terminal?id=' + encodeURIComponent(tab.id) + '&cols=' + cols + '&rows=' + rows;
}

function send(tab, payload) {
  if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
    tab.ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function sendInput(tab, data) {
  if (!tab || !data) return;
  if (tab.ended) {
    tab.ended = false;
    connect(tab);
  }
  if (!send(tab, { t: 'i', d: data })) tab.pending = (tab.pending || '') + data;
}

function connect(tab) {
  if (!tab || tab.ws) return;
  tab.ended = false;
  tab.attempt = 0;
  openSocket(tab);
}

function openSocket(tab) {
  if (!tab || tab.ws) return;
  let socket;
  try {
    socket = new WebSocket(wsUrl(tab));
  } catch (err) {
    scheduleReconnect(tab);
    return;
  }
  socket.binaryType = 'arraybuffer';
  tab.ws = socket;
  socket.onopen = () => {
    if (tab.ws !== socket) return;
    tab.attempt = 0;
    tab.connected = true;
    if (tab.term) {
      tab.term.write('\u001b[38;5;146m[connected]\u001b[0m\r\n');
      send(tab, { t: 'r', c: tab.term.cols, r: tab.term.rows });
    }
    if (tab.pending) {
      const pending = tab.pending;
      tab.pending = null;
      send(tab, { t: 'i', d: pending });
    }
  };
  socket.onmessage = (event) => {
    if (tab.ws !== socket) return;
    if (typeof event.data === 'string') {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        message = null;
      }
      if (message && message.t === 'exit') {
        tab.ended = true;
        if (tab.term) tab.term.write('\r\n\u001b[38;5;180m[session ended \u2014 press Enter to start a new one]\u001b[0m\r\n');
      }
      return;
    }
    if (tab.term) tab.term.write(new Uint8Array(event.data));
  };
  socket.onclose = () => {
    if (tab.ws !== socket) return;
    tab.ws = null;
    tab.connected = false;
    if (tab.ended) return;
    if (tab.term) tab.term.write('\r\n\u001b[38;5;180m[disconnected \u2014 reconnecting\u2026]\u001b[0m\r\n');
    scheduleReconnect(tab);
  };
  socket.onerror = () => {
    if (tab.ws === socket) {
      try {
        socket.close();
      } catch (err) {
        void err;
      }
    }
  };
}

function scheduleReconnect(tab) {
  if (!tab || tab.closed) return;
  const delay = BACKOFF[Math.min(tab.attempt, BACKOFF.length - 1)];
  tab.attempt += 1;
  if (tab.retryTimer) clearTimeout(tab.retryTimer);
  tab.retryTimer = setTimeout(() => {
    tab.retryTimer = null;
    if (tab.closed || !mounted) return;
    openSocket(tab);
  }, delay);
}

function fitTab(tab) {
  if (!tab || !tab.fit || !tab.term || !tab.hostEl || !tab.hostEl.isConnected) return;
  const rect = tab.hostEl.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return;
  try {
    tab.fit.fit();
  } catch (err) {
    return;
  }
  send(tab, { t: 'r', c: tab.term.cols, r: tab.term.rows });
}

function mouseOptions(event, overrides) {
  return Object.assign(
    {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: event.detail,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      button: event.button,
      buttons: event.buttons
    },
    overrides
  );
}

function mouseTracking(tab) {
  return Boolean(tab.term && tab.term.modes && tab.term.modes.mouseTrackingMode !== 'none');
}

function installSelection(tab) {
  const el = tab.hostEl;
  el.addEventListener(
    'mousedown',
    (event) => {
      if (!event.isTrusted) return;
      if (event.button === 2) {
        if (tab.term && tab.term.hasSelection()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (event.button !== 0) return;
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!mouseTracking(tab) || !(event.target instanceof Element)) return;
      const target = event.target.closest('.xterm-screen') ? event.target : null;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const press = event;
      target.dispatchEvent(new MouseEvent('mousedown', mouseOptions(press, { shiftKey: true })));
      const onUp = (up) => {
        if (!up.isTrusted || up.button !== 0) return;
        document.removeEventListener('mouseup', onUp, true);
        if (press.detail !== 1 || !tab.term || tab.term.hasSelection() || !mouseTracking(tab)) return;
        if (!target.isConnected) return;
        setTimeout(() => {
          if (!tab.term || tab.term.hasSelection() || !target.isConnected) return;
          target.dispatchEvent(new MouseEvent('mousedown', mouseOptions(press)));
          target.dispatchEvent(new MouseEvent('mouseup', mouseOptions(press, { buttons: 0 })));
        }, 0);
      };
      document.addEventListener('mouseup', onUp, true);
    },
    true
  );
  el.addEventListener(
    'wheel',
    () => {
      if (tab.term && mouseTracking(tab) && tab.term.hasSelection()) tab.term.clearSelection();
    },
    { capture: true, passive: true }
  );
}

function ensureTerm(tab) {
  if (tab.term) return;
  tab.term = new Terminal({
    theme: THEME,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 14,
    scrollback: 5000,
    allowProposedApi: false,
    cursorBlink: true,
    convertEol: false
  });
  tab.fit = new FitAddon.FitAddon();
  tab.term.loadAddon(tab.fit);
  tab.term.open(tab.hostEl);
  installSelection(tab);
  tab.term.onData((data) => {
    if (tab.ended && tab.term) tab.term.write('\r\n');
    sendInput(tab, data);
  });
  tab.observer = new ResizeObserver(() => {
    if (tab.fitTimer) clearTimeout(tab.fitTimer);
    tab.fitTimer = setTimeout(() => {
      tab.fitTimer = null;
      fitTab(tab);
    }, 120);
  });
  tab.observer.observe(tab.hostEl);
  setTimeout(() => fitTab(tab), 30);
}

function renderTabs() {
  if (!host) return;
  const strip = host.querySelector('.term-tabs');
  strip.textContent = '';
  for (const tab of tabs) {
    const label = h('span', { text: tab.title });
    const close = h(
      'button',
      {
        class: 'close',
        type: 'button',
        title: 'Close tab',
        'aria-label': 'Close tab',
        onclick: (event) => {
          event.stopPropagation();
          closeTab(tab);
        }
      },
      '\u00d7'
    );
    const el = h(
      'button',
      {
        class: 'term-tab' + (tab.id === active ? ' active' : ''),
        type: 'button',
        onclick: () => selectTab(tab.id),
        onmousedown: (event) => {
          if (event.button === 1) event.preventDefault();
        },
        onauxclick: (event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          event.stopPropagation();
          closeTab(tab);
        },
        ondblclick: (event) => {
          event.preventDefault();
          renameTab(tab);
        }
      },
      label,
      close
    );
    strip.appendChild(el);
  }
  strip.appendChild(
    h(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        title: 'New terminal tab',
        'aria-label': 'New terminal tab',
        onclick: () => addTab()
      },
      '+'
    )
  );
}

function renderBodies() {
  if (!host) return;
  const body = host.querySelector('.term-body');
  for (const tab of tabs) {
    if (!tab.hostEl) {
      tab.hostEl = h('div', { class: 'term-host' });
    }
    if (tab.id === active) {
      if (tab.hostEl.parentNode !== body) body.appendChild(tab.hostEl);
      tab.hostEl.classList.remove('hidden');
    } else {
      tab.hostEl.classList.add('hidden');
    }
  }
}

function selectTab(id) {
  const tab = tabs.find((item) => item.id === id);
  if (!tab) return;
  active = id;
  renderTabs();
  renderBodies();
  ensureTerm(tab);
  connect(tab);
  savePrefs();
  setTimeout(() => {
    fitTab(tab);
    if (tab.term) tab.term.focus();
  }, 20);
}

function addTab(title, id, command) {
  const tab = {
    id: id || newId(),
    title: title || 'Terminal ' + (tabs.length + 1),
    term: null,
    fit: null,
    ws: null,
    hostEl: null,
    connected: false,
    ended: false,
    attempt: 0,
    pending: command || null,
    closed: false
  };
  tabs.push(tab);
  active = tab.id;
  renderTabs();
  renderBodies();
  ensureTerm(tab);
  connect(tab);
  savePrefs();
  setTimeout(() => {
    fitTab(tab);
    if (tab.term) tab.term.focus();
  }, 20);
  return tab;
}

async function closeTab(tab) {
  if (!tab || tab.closing) return;
  tab.closing = true;
  let running = !tab.ended;
  if (running) {
    try {
      const status = await api.get('/api/terminal/status?id=' + encodeURIComponent(tab.id));
      running = status.running !== false;
    } catch (err) {
      running = true;
    }
  }
  if (tab.closed || !tabs.includes(tab)) return;
  if (running) {
    const ok = await confirmDialog('A process is still running. Close tab "' + tab.title + '" and kill its tmux session?', {
      danger: true,
      title: 'Close terminal',
      confirmLabel: 'Kill session'
    });
    if (!ok) {
      tab.closing = false;
      return;
    }
    if (tab.closed || !tabs.includes(tab)) return;
  }
  tab.closed = true;
  if (tab.retryTimer) clearTimeout(tab.retryTimer);
  if (tab.ws) {
    try {
      tab.ws.close();
    } catch (err) {
      void err;
    }
    tab.ws = null;
  }
  try {
    await api.post('/api/terminal/kill', { id: tab.id });
  } catch (err) {
    toast(err.message, 'danger');
  }
  if (tab.observer) tab.observer.disconnect();
  if (tab.term) tab.term.dispose();
  if (tab.hostEl) tab.hostEl.remove();
  tabs = tabs.filter((item) => item !== tab);
  if (active === tab.id) {
    active = tabs.length ? tabs[tabs.length - 1].id : null;
  }
  if (!tabs.length) {
    addTab();
    return;
  }
  renderTabs();
  renderBodies();
  savePrefs();
  if (active) selectTab(active);
}

async function renameTab(tab) {
  const value = await promptDialog('Rename tab', 'Tab title', tab.title);
  if (value === null) return;
  const title = value.trim();
  if (!title) return;
  tab.title = title;
  renderTabs();
  savePrefs();
}

export async function mount(container, ctx) {
  host = h('div', { class: 'pane pane-terminal' });
  const strip = h('div', { class: 'term-tabs' });
  const body = h('div', { class: 'term-body' });
  host.appendChild(strip);
  host.appendChild(body);
  container.appendChild(host);
  mounted = true;
  body.addEventListener(
    'contextmenu',
    (event) => {
      const tab = tabs.find((item) => item.hostEl && item.hostEl.contains(event.target)) || tabs.find((item) => item.id === active);
      if (!tab) return;
      event.preventDefault();
      event.stopPropagation();
      openTerminalMenu(event, tab);
    },
    true
  );
  document.addEventListener('mousedown', onDocumentDown);
  document.addEventListener('keydown', onDocumentKey);

  let prefs = {};
  let sessions = [];
  try {
    prefs = await api.get('/api/prefs');
  } catch (err) {
    prefs = {};
  }
  try {
    const data = await api.get('/api/terminal/sessions');
    sessions = Array.isArray(data.sessions) ? data.sessions : [];
  } catch (err) {
    sessions = [];
  }
  if (!mounted) return;

  const saved = prefs && prefs.terminal ? prefs.terminal : {};
  const savedTabs = Array.isArray(saved.tabs) ? saved.tabs : [];
  const seen = new Set();
  for (const item of savedTabs) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9]{1,16}$/.test(item.id)) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    tabs.push({
      id: item.id,
      title: typeof item.title === 'string' && item.title ? item.title : 'Session ' + item.id,
      term: null,
      fit: null,
      ws: null,
      hostEl: null,
      connected: false,
      ended: false,
      attempt: 0,
      pending: null,
      closed: false
    });
  }
  for (const id of sessions) {
    if (seen.has(id)) continue;
    seen.add(id);
    tabs.push({
      id,
      title: 'Session ' + id,
      term: null,
      fit: null,
      ws: null,
      hostEl: null,
      connected: false,
      ended: false,
      attempt: 0,
      pending: null,
      closed: false
    });
  }
  if (!tabs.length) {
    tabs.push({
      id: newId(),
      title: 'Terminal 1',
      term: null,
      fit: null,
      ws: null,
      hostEl: null,
      connected: false,
      ended: false,
      attempt: 0,
      pending: null,
      closed: false
    });
  }
  active = saved.active && tabs.some((tab) => tab.id === saved.active) ? saved.active : tabs[0].id;
  renderTabs();
  renderBodies();
  const first = tabs.find((tab) => tab.id === active);
  if (first) {
    ensureTerm(first);
    connect(first);
    setTimeout(() => fitTab(first), 60);
  }
  savePrefs();
  void ctx;
}

export function unmount() {
  mounted = false;
  closeMenu();
  document.removeEventListener('mousedown', onDocumentDown);
  document.removeEventListener('keydown', onDocumentKey);
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

export function destroy() {
  unmount();
  for (const tab of tabs) {
    tab.closed = true;
    if (tab.retryTimer) clearTimeout(tab.retryTimer);
    if (tab.fitTimer) clearTimeout(tab.fitTimer);
    if (tab.observer) tab.observer.disconnect();
    if (tab.ws) {
      try {
        tab.ws.close();
      } catch (err) {
        void err;
      }
      tab.ws = null;
    }
    if (tab.term) tab.term.dispose();
    if (tab.hostEl) tab.hostEl.remove();
  }
  tabs = [];
  active = null;
  if (host && host.parentNode) host.remove();
  host = null;
}

export function focus() {
  const tab = tabs.find((item) => item.id === active);
  if (tab && tab.term) tab.term.focus();
}

export function refit() {
  const tab = tabs.find((item) => item.id === active);
  if (tab) setTimeout(() => fitTab(tab), 30);
}

export function openInTerminal(command) {
  if (!mounted || !host) return;
  const tab = addTab(null, null, command ? command + '\r' : null);
  if (tab && tab.term) tab.term.focus();
}

export function runInActiveTerminal(command) {
  if (!mounted || !host || !command) return;
  let tab = tabs.find((item) => item.id === active);
  if (!tab) tab = addTab();
  ensureTerm(tab);
  connect(tab);
  sendInput(tab, command + '\r');
  if (tab.term) tab.term.focus();
}

export function shellQuote(path) {
  return "'" + String(path).replace(/'/g, "'\\''") + "'";
}
