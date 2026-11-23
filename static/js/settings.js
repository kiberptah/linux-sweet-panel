import { api } from './api.js';
import { h, toast, confirmDialog } from './ui.js';

let host = null;
let mounted = false;
let info = null;
let checking = false;
let applying = false;

function row(label, value) {
  return [h('dt', { text: label }), h('dd', { text: value === null || value === undefined || value === '' ? '\u2014' : String(value) })];
}

function render() {
  if (!host || !info) return;
  host.textContent = '';
  host.appendChild(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', { text: 'Settings' }), h('div', { class: 'sub', text: 'Panel version, network and updates' }))
    )
  );

  const list = h('dl', { class: 'kv' });
  for (const item of row('Version', info.version)) list.appendChild(item);
  for (const item of row('Commit', info.commit || (info.is_git ? 'unknown' : 'not a git checkout'))) list.appendChild(item);
  for (const item of row('Port', info.port)) list.appendChild(item);
  for (const item of row('Bind address', info.bind)) list.appendChild(item);
  for (const item of row('TLS', info.tls ? 'enabled' : 'disabled')) list.appendChild(item);
  for (const item of row('Repository', info.repo)) list.appendChild(item);
  for (const item of row('Branch', info.branch)) list.appendChild(item);
  for (const item of row('Install directory', info.install_dir)) list.appendChild(item);

  const checkBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Check for updates');
  const applyBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Update now');
  const result = h('div', { class: 'hint', text: '' });

  checkBtn.addEventListener('click', async () => {
    if (checking) return;
    checking = true;
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking\u2026';
    try {
      const data = await api.get('/api/update/check');
      result.textContent = data.update_available
        ? 'Update available: ' + (data.current || '?') + ' \u2192 ' + (data.latest || '?')
        : 'Up to date (' + (data.current || '?') + ')';
      result.className = data.update_available ? 'warn-text' : 'hint';
    } catch (err) {
      result.textContent = err.message;
      result.className = 'warn-text';
    } finally {
      checking = false;
      checkBtn.disabled = false;
      checkBtn.textContent = 'Check for updates';
    }
  });

  applyBtn.addEventListener('click', async () => {
    if (applying) return;
    const ok = await confirmDialog('Update the panel to the latest commit on branch "' + (info.branch || 'main') + '"? The service restarts afterwards.', {
      danger: true,
      title: 'Update now',
      confirmLabel: 'Update'
    });
    if (!ok) return;
    applying = true;
    applyBtn.disabled = true;
    try {
      const data = await api.post('/api/update/apply');
      toast('Updated ' + (data.from || '?') + ' \u2192 ' + (data.to || '?'), 'ok');
      waitForRestart();
    } catch (err) {
      toast(err.message, 'danger');
      applying = false;
      applyBtn.disabled = false;
    }
  });

  host.appendChild(
    h(
      'div',
      { class: 'grid grid-2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'card-title', text: 'About' })), list),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('div', { class: 'card-title', text: 'Updates' })),
        h('div', { class: 'toolbar' }, checkBtn, applyBtn),
        result,
        h('div', { class: 'hint', text: 'Updates run git fetch and git reset --hard in the install directory, then restart the service.' })
      )
    )
  );

  host.appendChild(
    h(
      'div',
      { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' }, h('div', { class: 'card-title', text: 'Changing the port' })),
      h('div', { class: 'hint', text: 'Edit /etc/linuxpanel/config.json and set "port", then run: systemctl restart linuxpanel' })
    )
  );
}

function waitForRestart() {
  const overlay = h(
    'div',
    { class: 'overlay-restart' },
    h('div', { class: 'spinner' }),
    h('div', { text: 'Restarting\u2026' }),
    h('div', { class: 'hint', text: 'Waiting for the panel to come back' })
  );
  document.body.appendChild(overlay);
  const started = Date.now();
  const poll = async () => {
    if (Date.now() - started > 90000) {
      overlay.remove();
      toast('Panel did not come back within 90 seconds', 'danger');
      applying = false;
      return;
    }
    try {
      await api.get('/api/me');
      location.reload();
      return;
    } catch (err) {
      setTimeout(poll, 2000);
    }
  };
  setTimeout(poll, 2000);
}

async function load() {
  try {
    info = await api.get('/api/settings');
    if (mounted) render();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

export async function mount(container) {
  mounted = true;
  host = h('div', { class: 'page' });
  container.appendChild(host);
  await load();
}

export function unmount() {
  mounted = false;
}

export function destroy() {
  unmount();
  if (host && host.parentNode) host.remove();
  host = null;
}
