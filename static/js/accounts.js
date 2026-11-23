import { api } from './api.js';
import { h, toast, modal, confirmDialog, promptDialog, badge, formatDate } from './ui.js';

let host = null;
let ctxRef = null;
let mounted = false;
let tab = 'users';
let showSystem = false;
let users = [];
let groups = [];
let sudoGroup = null;
let auditFilter = '';

function tabsBar() {
  const items = [
    ['users', 'Users'],
    ['logins', 'Login history'],
    ['audit', 'Audit log']
  ];
  const bar = h('div', { class: 'tabs' });
  for (const [key, label] of items) {
    bar.appendChild(
      h(
        'button',
        {
          class: 'tab' + (tab === key ? ' active' : ''),
          type: 'button',
          onclick: () => {
            tab = key;
            render();
          }
        },
        label
      )
    );
  }
  return bar;
}

function render() {
  if (!host) return;
  host.textContent = '';
  host.appendChild(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', { text: 'Accounts' }), h('div', { class: 'sub', text: 'Linux users, groups, keys and activity' })),
      tab === 'users'
        ? h(
            'div',
            { class: 'toolbar' },
            h(
              'label',
              { class: 'check' },
              h('input', {
                type: 'checkbox',
                checked: showSystem,
                onchange: (event) => {
                  showSystem = event.target.checked;
                  loadUsers();
                }
              }),
              h('span', { text: 'Show system users' })
            ),
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => createUser() }, 'Create user')
          )
        : null
    )
  );
  host.appendChild(tabsBar());
  const body = h('div', {});
  host.appendChild(body);
  if (tab === 'users') renderUsers(body);
  else if (tab === 'logins') renderLogins(body);
  else renderAudit(body);
}

function renderUsers(body) {
  const table = h(
    'table',
    {},
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { text: 'User' }),
        h('th', { class: 'num', text: 'UID' }),
        h('th', { text: 'Groups' }),
        h('th', { text: 'Flags' }),
        h('th', { class: 'num', text: 'Keys' }),
        h('th', { text: '' })
      )
    )
  );
  const tbody = h('tbody');
  table.appendChild(tbody);
  if (!users.length) {
    tbody.appendChild(h('tr', {}, h('td', { colspan: '6', class: 'empty', text: 'No users' })));
  }
  for (const user of users) {
    const flags = [];
    if (user.sudo) flags.push(badge('sudo', 'ok'));
    if (user.locked) flags.push(badge('locked', 'warn'));
    if (user.panel_blocked) flags.push(badge('panel-blocked', 'danger'));
    if (user.ssh_blocked) flags.push(badge('ssh-blocked', 'danger'));
    if (user.system) flags.push(badge('system', 'muted'));
    tbody.appendChild(
      h(
        'tr',
        {},
        h('td', {}, h('span', { class: 'mono', text: user.name }), user.name === 'root' ? h('span', { class: 'muted', text: ' \u00b7 superuser' }) : null),
        h('td', { class: 'num mono', text: user.uid }),
        h('td', { class: 'muted', text: (user.groups || []).join(', ') || '\u2014' }),
        h('td', {}, h('div', { class: 'toolbar', style: { gap: '4px' } }, flags.length ? flags : h('span', { class: 'muted', text: '\u2014' }))),
        h('td', { class: 'num mono', text: user.keys_count === null || user.keys_count === undefined ? '\u2014' : user.keys_count }),
        h(
          'td',
          {},
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openDetail(user.name) }, 'Manage')
        )
      )
    );
  }
  body.appendChild(h('div', { class: 'table-wrap' }, table));
}

async function loadUsers() {
  try {
    const data = await api.get('/api/accounts?system=' + (showSystem ? '1' : '0'));
    users = Array.isArray(data.users) ? data.users : [];
    sudoGroup = data.sudo_group || null;
    if (mounted) render();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

async function loadGroups() {
  try {
    const data = await api.get('/api/groups');
    groups = Array.isArray(data.groups) ? data.groups : [];
  } catch (err) {
    groups = [];
  }
}

function groupChecks(selected) {
  const list = h('div', { class: 'group-list' });
  const boxes = [];
  for (const group of groups) {
    const input = h('input', { type: 'checkbox', checked: selected.includes(group.name) });
    boxes.push({ name: group.name, input });
    list.appendChild(h('label', { class: 'check' }, input, h('span', { text: group.name })));
  }
  return { list, boxes };
}

async function createUser() {
  const name = h('input', { class: 'input', type: 'text', spellcheck: 'false', placeholder: 'alice' });
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const confirm = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const shell = h(
    'select',
    { class: 'input' },
    ['/bin/bash', '/bin/sh', '/bin/zsh', '/usr/bin/fish'].map((value) => h('option', { value, text: value }))
  );
  shell.value = '/bin/bash';
  const sudo = h('input', { type: 'checkbox' });
  const groupBox = groupChecks([]);
  const body = h(
    'div',
    { class: 'form-grid' },
    h('label', { class: 'field' }, h('span', { text: 'Username' }), name),
    h('label', { class: 'field' }, h('span', { text: 'Password' }), password),
    h('label', { class: 'field' }, h('span', { text: 'Confirm password' }), confirm),
    h('label', { class: 'field' }, h('span', { text: 'Shell' }), shell),
    h('label', { class: 'check' }, sudo, h('span', { text: 'Grant sudo' + (sudoGroup ? ' (' + sudoGroup + ')' : '') })),
    h('div', { class: 'field' }, h('span', { text: 'Extra groups' }), groupBox.list)
  );
  const result = await modal({
    title: 'Create user',
    body,
    wide: true,
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Create',
        variant: 'primary',
        onClick: async () => {
          if (!name.value.trim()) {
            toast('Username is required', 'danger');
            return false;
          }
          if (!password.value) {
            toast('Password is required', 'danger');
            return false;
          }
          if (password.value !== confirm.value) {
            toast('Passwords do not match', 'danger');
            return false;
          }
          const picked = groupBox.boxes.filter((box) => box.input.checked).map((box) => box.name);
          await api.post('/api/accounts/create', {
            name: name.value.trim(),
            password: password.value,
            shell: shell.value,
            sudo: sudo.checked,
            groups: picked
          });
          toast('User created', 'ok');
          await loadUsers();
          return undefined;
        }
      }
    ]
  });
  void result;
}

function switchRow(label, checked, hint, onChange, disabled) {
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

function buildDetail(body, user, keys, rerender) {
  const isSelf = ctxRef && ctxRef.me && ctxRef.me.name === user.name;
  const flags = [];
  if (user.sudo) flags.push(badge('sudo', 'ok'));
  if (user.locked) flags.push(badge('locked', 'warn'));
  if (user.panel_blocked) flags.push(badge('panel-blocked', 'danger'));
  if (user.ssh_blocked) flags.push(badge('ssh-blocked', 'danger'));
  if (user.system) flags.push(badge('system', 'muted'));
  body.appendChild(
    h(
      'div',
      { class: 'toolbar' },
      h('span', { class: 'mono', text: user.name }),
      h('span', { class: 'muted mono', text: 'uid ' + user.uid + ' \u00b7 ' + user.shell }),
      h('div', { class: 'spacer', style: { flex: '1' } }),
      flags
    )
  );

  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'New password' });
  const pwBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Set password');
  pwBtn.addEventListener('click', async () => {
    if (!pw.value) {
      toast('Password is required', 'danger');
      return;
    }
    pwBtn.disabled = true;
    try {
      await api.post('/api/accounts/password', { name: user.name, password: pw.value });
      pw.value = '';
      toast('Password updated', 'ok');
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      pwBtn.disabled = false;
    }
  });
  body.appendChild(
    h('div', { class: 'detail-section' }, h('h3', { text: 'Password reset' }), h('div', { class: 'toolbar' }, pw, pwBtn))
  );

  body.appendChild(
    switchRow('Sudo access', user.sudo, sudoGroup ? 'Membership in the ' + sudoGroup + ' group.' : 'No sudo group on this system.', async (checked) => {
      await api.post('/api/accounts/sudo', { name: user.name, enabled: checked });
      user.sudo = checked;
      toast('Sudo ' + (checked ? 'granted' : 'revoked'), 'ok');
      await loadUsers();
      rerender();
    })
  );

  const groupBox = groupChecks(user.groups || []);
  const groupBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Save groups');
  groupBtn.addEventListener('click', async () => {
    groupBtn.disabled = true;
    try {
      const picked = groupBox.boxes.filter((box) => box.input.checked).map((box) => box.name);
      await api.post('/api/accounts/groups', { name: user.name, groups: picked });
      user.groups = picked;
      toast('Groups updated', 'ok');
      await loadUsers();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      groupBtn.disabled = false;
    }
  });
  body.appendChild(
    h('div', { class: 'detail-section' }, h('h3', { text: 'Groups' }), groupBox.list, h('div', { class: 'toolbar' }, groupBtn))
  );

  const loginSection = h('div', { class: 'detail-section' }, h('h3', { text: 'Login controls' }));
  loginSection.appendChild(
    switchRow('Lock password (passwd -l)', user.locked, 'Blocks password logins system-wide, including SSH and the panel.', async (checked) => {
      await api.post('/api/accounts/lock', { name: user.name, locked: checked });
      user.locked = checked;
      toast('Password ' + (checked ? 'locked' : 'unlocked'), 'ok');
      await loadUsers();
      rerender();
    }).firstChild
  );
  loginSection.appendChild(
    switchRow(
      'Block panel login',
      user.panel_blocked,
      isSelf ? 'You cannot block your own panel login.' : 'Destroys existing panel sessions for this user.',
      async (checked) => {
        await api.post('/api/accounts/panel-block', { name: user.name, blocked: checked });
        user.panel_blocked = checked;
        toast('Panel login ' + (checked ? 'blocked' : 'allowed'), 'ok');
        await loadUsers();
        rerender();
      },
      isSelf
    ).firstChild
  );
  loginSection.appendChild(
    switchRow('Block SSH login', user.ssh_blocked, 'Adds the user to DenyUsers in the managed sshd_config block.', async (checked) => {
      await api.post('/api/accounts/ssh-block', { name: user.name, blocked: checked });
      user.ssh_blocked = checked;
      toast('SSH login ' + (checked ? 'blocked' : 'allowed'), 'ok');
      await loadUsers();
      rerender();
    }).firstChild
  );
  body.appendChild(loginSection);

  const keyList = h('div', { class: 'keys' });
  if (!keys.length) keyList.appendChild(h('div', { class: 'hint', text: 'No SSH keys' }));
  for (const key of keys) {
    const remove = h('button', { class: 'btn btn-sm btn-danger', type: 'button' }, 'Remove');
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await api.post('/api/accounts/keys/remove', { name: user.name, fingerprint: key.fingerprint });
        toast('Key removed', 'ok');
        keys = keys.filter((item) => item.fingerprint !== key.fingerprint);
        rerender();
      } catch (err) {
        toast(err.message, 'danger');
        remove.disabled = false;
      }
    });
    keyList.appendChild(
      h(
        'div',
        { class: 'key-row' },
        h('span', { class: 'mono', text: key.type }),
        h('span', { class: 'fp', title: key.fingerprint, text: key.comment || key.fingerprint }),
        remove
      )
    );
  }
  const keyInput = h('textarea', { class: 'input', rows: '2', placeholder: 'ssh-ed25519 AAAA... user@host', spellcheck: 'false' });
  const keyBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Add key');
  keyBtn.addEventListener('click', async () => {
    const value = keyInput.value.trim();
    if (!value) {
      toast('Paste a public key first', 'danger');
      return;
    }
    keyBtn.disabled = true;
    try {
      await api.post('/api/accounts/keys/add', { name: user.name, key: value });
      keyInput.value = '';
      toast('Key added', 'ok');
      const data = await api.get('/api/accounts/keys?name=' + encodeURIComponent(user.name));
      keys = Array.isArray(data.keys) ? data.keys : [];
      rerender();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      keyBtn.disabled = false;
    }
  });
  body.appendChild(
    h('div', { class: 'detail-section' }, h('h3', { text: 'SSH keys' }), keyList, keyInput, h('div', { class: 'toolbar' }, keyBtn))
  );

  const removeHome = h('input', { type: 'checkbox' });
  const deleteBtn = h('button', { class: 'btn btn-danger btn-sm', type: 'button' }, 'Delete user');
  const blockedDelete = user.name === 'root' || isSelf;
  deleteBtn.disabled = blockedDelete;
  deleteBtn.addEventListener('click', async () => {
    const typed = await promptDialog('Delete ' + user.name, 'Type the username to confirm deletion', '');
    if (typed === null) return;
    if (typed.trim() !== user.name) {
      toast('Username does not match', 'danger');
      return;
    }
    deleteBtn.disabled = true;
    try {
      await api.post('/api/accounts/delete', { name: user.name, remove_home: removeHome.checked });
      toast('User deleted', 'ok');
      await loadUsers();
      rerender();
    } catch (err) {
      toast(err.message, 'danger');
      deleteBtn.disabled = false;
    }
  });
  body.appendChild(
    h(
      'div',
      { class: 'detail-section' },
      h('h3', { text: 'Delete user' }),
      blockedDelete ? h('div', { class: 'hint', text: 'Root and the current user cannot be deleted.' }) : null,
      h('label', { class: 'check' }, removeHome, h('span', { text: 'Also remove home directory' })),
      h('div', { class: 'toolbar' }, deleteBtn)
    )
  );
}

async function openDetail(name) {
  const user = users.find((item) => item.name === name);
  if (!user) return;
  let keys = [];
  try {
    const data = await api.get('/api/accounts/keys?name=' + encodeURIComponent(name));
    keys = Array.isArray(data.keys) ? data.keys : [];
  } catch (err) {
    keys = [];
  }
  const body = h('div', { class: 'form-grid' });
  const rerender = () => {
    body.textContent = '';
    buildDetail(body, user, keys, rerender);
  };
  rerender();
  await modal({ title: 'User ' + name, body, wide: true, actions: [{ label: 'Close' }] });
}

function simpleTable(headers, rows, emptyText) {
  const tbody = h('tbody');
  if (!rows.length) tbody.appendChild(h('tr', {}, h('td', { colspan: String(headers.length), class: 'empty', text: emptyText })));
  for (const row of rows) tbody.appendChild(row);
  return h(
    'div',
    { class: 'table-wrap' },
    h('table', {}, h('thead', {}, h('tr', {}, headers.map((header) => h('th', { text: header })))), tbody)
  );
}

async function renderLogins(body) {
  body.appendChild(h('div', { class: 'empty', text: 'Loading login history\u2026' }));
  let data = {};
  try {
    data = await api.get('/api/logins');
  } catch (err) {
    body.textContent = '';
    body.appendChild(h('div', { class: 'empty', text: err.message }));
    return;
  }
  if (!mounted || tab !== 'logins') return;
  body.textContent = '';
  const ssh = Array.isArray(data.ssh) ? data.ssh : [];
  const failed = Array.isArray(data.failed) ? data.failed : [];
  const panel = Array.isArray(data.panel) ? data.panel : [];
  body.appendChild(h('h2', { text: 'SSH logins', style: { margin: '4px 0 8px' } }));
  body.appendChild(
    simpleTable(
      ['User', 'TTY', 'Host', 'Start', 'End'],
      ssh.map((row) =>
        h(
          'tr',
          {},
          h('td', { class: 'mono', text: row.user }),
          h('td', { class: 'mono muted', text: row.tty }),
          h('td', { class: 'mono muted', text: row.host }),
          h('td', { class: 'mono muted', text: row.start }),
          h('td', { class: 'mono muted', text: row.end || '' })
        )
      ),
      'No SSH logins recorded'
    )
  );
  body.appendChild(h('h2', { text: 'Failed SSH logins', style: { margin: '18px 0 8px' } }));
  body.appendChild(
    simpleTable(
      ['User', 'TTY', 'Host', 'Start'],
      failed.map((row) =>
        h(
          'tr',
          {},
          h('td', { class: 'mono', text: row.user }),
          h('td', { class: 'mono muted', text: row.tty }),
          h('td', { class: 'mono muted', text: row.host }),
          h('td', { class: 'mono muted', text: row.start })
        )
      ),
      'No failed logins recorded'
    )
  );
  body.appendChild(h('h2', { text: 'Panel logins', style: { margin: '18px 0 8px' } }));
  body.appendChild(
    simpleTable(
      ['Time', 'User', 'IP', 'Action', 'OK'],
      panel.map((row) =>
        h(
          'tr',
          {},
          h('td', { class: 'mono muted', text: formatDate(row.ts) }),
          h('td', { class: 'mono', text: row.user || '' }),
          h('td', { class: 'mono muted', text: row.ip || '' }),
          h('td', { text: row.action }),
          h('td', {}, row.ok ? badge('ok', 'ok') : badge('failed', 'danger'))
        )
      ),
      'No panel logins recorded'
    )
  );
}

async function renderAudit(body) {
  const filterInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Filter by user, action, target or detail',
    value: auditFilter,
    style: { maxWidth: '340px' },
    oninput: () => {
      auditFilter = filterInput.value;
      draw();
    }
  });
  const holder = h('div', {});
  body.appendChild(h('div', { class: 'toolbar', style: { marginBottom: '10px' } }, filterInput));
  body.appendChild(holder);
  let entries = [];
  try {
    const data = await api.get('/api/audit?limit=300');
    entries = Array.isArray(data.entries) ? data.entries : [];
  } catch (err) {
    holder.appendChild(h('div', { class: 'empty', text: err.message }));
    return;
  }
  const draw = () => {
    holder.textContent = '';
    const needle = auditFilter.trim().toLowerCase();
    const rows = entries.filter((entry) => {
      if (!needle) return true;
      return [entry.user, entry.action, entry.target, entry.detail, entry.ip]
        .filter((value) => value !== null && value !== undefined)
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
    holder.appendChild(
      simpleTable(
        ['Time', 'User', 'IP', 'Action', 'Target', 'Detail', 'OK'],
        rows.map((entry) =>
          h(
            'tr',
            {},
            h('td', { class: 'mono muted', text: formatDate(entry.ts) }),
            h('td', { class: 'mono', text: entry.user || '' }),
            h('td', { class: 'mono muted', text: entry.ip || '' }),
            h('td', { text: entry.action }),
            h('td', { class: 'mono muted', text: entry.target === null || entry.target === undefined ? '' : String(entry.target) }),
            h('td', { class: 'mono muted', text: entry.detail === null || entry.detail === undefined ? '' : String(entry.detail) }),
            h('td', {}, entry.ok ? badge('ok', 'ok') : badge('failed', 'danger'))
          )
        ),
        'No audit entries'
      )
    );
  };
  draw();
}

export async function mount(container, ctx) {
  ctxRef = ctx;
  mounted = true;
  host = h('div', { class: 'page' });
  container.appendChild(host);
  await loadGroups();
  await loadUsers();
  if (mounted && host) render();
}

export function unmount() {
  mounted = false;
}

export function destroy() {
  unmount();
  if (host && host.parentNode) host.remove();
  host = null;
}
