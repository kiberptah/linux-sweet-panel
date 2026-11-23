import { api } from './api.js';
import { h } from './ui.js';
import * as dashboard from './dashboard.js';
import * as workspace from './workspace.js';
import * as accounts from './accounts.js';
import * as security from './security.js';
import * as settings from './settings.js';

const VIEWS = { dashboard, workspace, accounts, security, settings };
const ADMIN_VIEWS = new Set(['accounts', 'security', 'settings']);

const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const content = document.getElementById('content');
const loginForm = document.getElementById('login-form');
const loginUser = document.getElementById('login-user');
const loginPass = document.getElementById('login-pass');
const loginError = document.getElementById('login-error');
const loginSubmit = document.getElementById('login-submit');
const topHost = document.getElementById('top-host');
const topUser = document.getElementById('top-user');
const sidebarFoot = document.getElementById('sidebar-foot');
const navItems = Array.from(document.querySelectorAll('.nav-item'));

let me = null;
let currentName = null;
let currentView = null;
let workspaceHost = null;
let busy = false;

const ctx = {
  me: null,
  navigate,
  openWorkspace,
  openTerminal
};

function navigate(name) {
  const target = '#/' + name;
  if (location.hash === target) {
    route();
    return;
  }
  location.hash = target;
}

function openWorkspace(pane) {
  if (location.hash !== '#/workspace') {
    location.hash = '#/workspace';
    route();
  }
  if (pane) workspace.focus(pane);
}

function openTerminal(command) {
  if (location.hash !== '#/workspace') {
    location.hash = '#/workspace';
    route();
  }
  workspace.openTerminal(command);
}

function updateNav(name) {
  for (const item of navItems) {
    item.classList.toggle('active', item.dataset.route === name);
  }
}

function route() {
  if (!me) return;
  let name = (location.hash || '').replace(/^#\/?/, '').split('?')[0] || 'dashboard';
  if (!VIEWS[name] || (ADMIN_VIEWS.has(name) && !me.admin)) {
    name = 'dashboard';
    if (location.hash !== '#/dashboard') {
      location.hash = '#/dashboard';
      return;
    }
  }
  if (name === currentName) return;
  if (currentName === 'workspace') {
    workspace.unmount();
  } else if (currentView && currentView.unmount) {
    currentView.unmount();
  }
  content.textContent = '';
  currentName = name;
  currentView = VIEWS[name];
  if (name === 'workspace') {
    if (!workspaceHost) workspaceHost = h('div', { class: 'workspace-host' });
    content.appendChild(workspaceHost);
    workspace.mount(workspaceHost, ctx);
  } else {
    currentView.mount(content, ctx);
  }
  updateNav(name);
}

function setLoginError(message) {
  if (message) {
    loginError.textContent = message;
    loginError.classList.remove('hidden');
  } else {
    loginError.textContent = '';
    loginError.classList.add('hidden');
  }
}

function showApp(user) {
  me = user;
  ctx.me = user;
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
  topHost.textContent = user.hostname || '';
  topUser.textContent = user.name + (user.admin ? ' \u00b7 admin' : '');
  for (const item of document.querySelectorAll('.admin-only')) {
    item.classList.toggle('hidden', !user.admin);
  }
  sidebarFoot.textContent = '';
  sidebarFoot.appendChild(h('span', { text: 'v' + (user.version || '') }));
  sidebarFoot.appendChild(h('span', { text: user.home || '' }));
  route();
}

function showLogin(message) {
  me = null;
  ctx.me = null;
  if (currentName === 'workspace') {
    workspace.destroy();
  } else if (currentView && currentView.unmount) {
    currentView.unmount();
  }
  currentName = null;
  currentView = null;
  content.textContent = '';
  appView.classList.add('hidden');
  loginView.classList.remove('hidden');
  loginPass.value = '';
  setLoginError(message || '');
  loginUser.focus();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const username = loginUser.value.trim();
  const password = loginPass.value;
  if (!username || !password) {
    setLoginError('Enter your username and password.');
    return;
  }
  busy = true;
  loginSubmit.disabled = true;
  loginSubmit.textContent = 'Signing in\u2026';
  setLoginError('');
  try {
    const data = await api.post('/api/login', { username, password });
    loginPass.value = '';
    showApp(data.user);
  } catch (err) {
    setLoginError(err && err.message ? err.message : 'login failed');
    loginPass.value = '';
    loginPass.focus();
  } finally {
    busy = false;
    loginSubmit.disabled = false;
    loginSubmit.textContent = 'Sign in';
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  try {
    await api.post('/api/logout');
  } catch (err) {
    void err;
  }
  showLogin('');
});

window.addEventListener('lp:unauthorized', () => {
  if (me) showLogin('Your session expired. Please sign in again.');
});

window.addEventListener('hashchange', route);

async function boot() {
  try {
    const user = await api.get('/api/me');
    showApp(user);
  } catch (err) {
    showLogin('');
  }
}

boot();
