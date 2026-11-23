import { api } from './api.js';
import { h, toast, badge } from './ui.js';

let host = null;
let mounted = false;
let data = null;
let busy = false;

function toggle(label, checked, hint, onChange, disabled) {
  const input = h('input', {
    type: 'checkbox',
    checked,
    disabled,
    onchange: async () => {
      input.disabled = true;
      try {
        await onChange(input.checked);
      } catch (err) {
        input.checked = !input.checked;
        toast(err.message, 'danger');
      } finally {
        input.disabled = false;
      }
    }
  });
  return h(
    'div',
    { class: 'detail-section' },
    h('label', { class: 'switch' }, input, h('span', { class: 'switch-track' }), h('span', { text: label })),
    hint ? h('div', { class: 'hint', text: hint }) : null
  );
}

function render() {
  if (!host || !data) return;
  host.textContent = '';
  host.appendChild(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', { text: 'Security' }), h('div', { class: 'sub', text: 'SSH access and root hardening' })),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => load() }, 'Refresh')
    )
  );

  if (!data.sshd_installed) {
    host.appendChild(
      h(
        'div',
        { class: 'card', style: { borderColor: 'rgba(255,198,154,.4)' } },
        h('div', { class: 'card-title', text: 'OpenSSH server not installed' }),
        h('div', { class: 'hint', text: 'SSH controls are disabled because sshd was not found on this server.' })
      )
    );
  }

  const rootBlocked = data.root_ssh_blocked === true;
  const effective = data.permit_root_login_effective;
  const rootCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title', text: 'Root SSH login' }), rootBlocked ? badge('blocked', 'ok') : badge('allowed', 'warn')),
    toggle(
      'Block root SSH login',
      rootBlocked,
      'Writes PermitRootLogin no into the managed sshd_config block.',
      async (checked) => {
        await api.post('/api/security/root-ssh', { blocked: checked });
        toast('Root SSH ' + (checked ? 'blocked' : 'allowed'), 'ok');
        await load();
      },
      !data.sshd_installed
    ),
    h('div', { class: 'card-meta', text: 'Effective PermitRootLogin: ' + (effective === null || effective === undefined ? 'unknown' : effective) }),
    h('div', { class: 'warn-text', text: 'Make sure you have another sudo account with working SSH access before blocking root.' })
  );

  const hardenEnabled = data.root_locked === true && rootBlocked && (data.panel_blocked || []).includes('root');
  const hardenCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title', text: 'Harden root' }), hardenEnabled ? badge('hardened', 'ok') : badge('not hardened', 'muted')),
    toggle(
      'Harden root account',
      hardenEnabled,
      'Locks the root password (passwd -l), blocks root SSH login and blocks root from the panel.',
      async (checked) => {
        const result = await api.post('/api/security/harden-root', { enabled: checked });
        const warnings = Array.isArray(result.warnings) ? result.warnings : [];
        for (const warning of warnings) toast(warning, 'warn');
        toast('Root ' + (checked ? 'hardened' : 'restored'), 'ok');
        await load();
      },
      !data.sshd_installed
    ),
    h('div', { class: 'card-meta', text: 'Root password locked: ' + (data.root_locked ? 'yes' : 'no') })
  );

  const infoCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title', text: 'SSH configuration' })),
    h(
      'dl',
      { class: 'kv' },
      h('dt', { text: 'Config file' }),
      h('dd', { text: data.sshd_config_path || '\u2014' }),
      h('dt', { text: 'Password authentication' }),
      h('dd', { text: data.password_auth_effective === null || data.password_auth_effective === undefined ? 'unknown' : data.password_auth_effective }),
      h('dt', { text: 'Root SSH blocked' }),
      h('dd', { text: rootBlocked ? 'yes' : 'no' })
    )
  );

  host.appendChild(h('div', { class: 'grid grid-3' }, rootCard, hardenCard, infoCard));

  const denied = Array.isArray(data.ssh_denied) ? data.ssh_denied : [];
  const blocked = Array.isArray(data.panel_blocked) ? data.panel_blocked : [];
  const deniedCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title', text: 'SSH-denied users' })),
    denied.length ? null : h('div', { class: 'empty', text: 'No users denied SSH access' })
  );
  for (const name of denied) {
    const button = h('button', { class: 'btn btn-sm', type: 'button' }, 'Unblock');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api.post('/api/accounts/ssh-block', { name, blocked: false });
        toast('SSH access restored for ' + name, 'ok');
        await load();
      } catch (err) {
        toast(err.message, 'danger');
        button.disabled = false;
      }
    });
    deniedCard.appendChild(h('div', { class: 'key-row' }, h('span', { class: 'mono', text: name }), h('div', { class: 'spacer', style: { flex: '1' } }), button));
  }

  const blockedCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title', text: 'Panel-blocked users' })),
    blocked.length ? null : h('div', { class: 'empty', text: 'No users blocked from the panel' })
  );
  for (const name of blocked) {
    const button = h('button', { class: 'btn btn-sm', type: 'button' }, 'Unblock');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api.post('/api/accounts/panel-block', { name, blocked: false });
        toast('Panel access restored for ' + name, 'ok');
        await load();
      } catch (err) {
        toast(err.message, 'danger');
        button.disabled = false;
      }
    });
    blockedCard.appendChild(h('div', { class: 'key-row' }, h('span', { class: 'mono', text: name }), h('div', { class: 'spacer', style: { flex: '1' } }), button));
  }

  host.appendChild(h('div', { class: 'grid grid-2', style: { marginTop: '14px' } }, deniedCard, blockedCard));
}

async function load() {
  if (busy) return;
  busy = true;
  try {
    data = await api.get('/api/security');
    if (mounted) render();
  } catch (err) {
    toast(err.message, 'danger');
  } finally {
    busy = false;
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
