function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') {
        el.className = value;
      } else if (key === 'text') {
        el.textContent = String(value);
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value);
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, value);
      }
    }
  }
  append(el, children);
  return el;
}

export function toast(message, type = 'info', timeout) {
  const root = document.getElementById('toasts');
  if (!root) return null;
  const el = h('div', { class: 'toast toast-' + type, role: 'status' }, h('span', { text: String(message) }));
  root.appendChild(el);
  const ms = timeout || (type === 'danger' ? 6000 : 4000);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 220);
  }, ms);
  return el;
}

export function modal({ title, body, actions = [], wide = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(null);
      }
    };
    const footer = h('div', { class: 'modal-actions' });
    for (const action of actions) {
      const button = h(
        'button',
        {
          class: 'btn ' + (action.variant ? 'btn-' + action.variant : 'btn-ghost'),
          type: 'button',
          onclick: async () => {
            if (action.onClick) {
              button.disabled = true;
              let result;
              try {
                result = await action.onClick(close);
              } catch (err) {
                button.disabled = false;
                toast(err && err.message ? err.message : 'action failed', 'danger');
                return;
              }
              button.disabled = false;
              if (result === false) return;
            }
            close(action.value === undefined ? action.label : action.value);
          }
        },
        action.label
      );
      footer.appendChild(button);
    }
    const overlay = h(
      'div',
      {
        class: 'modal-overlay',
        onclick: (event) => {
          if (event.target === overlay) close(null);
        }
      },
      h(
        'div',
        { class: 'modal' + (wide ? ' modal-wide' : ''), role: 'dialog', 'aria-modal': 'true' },
        h(
          'div',
          { class: 'modal-head' },
          h('h2', { text: title || '' }),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, '\u00d7')
        ),
        h('div', { class: 'modal-body' }, body),
        actions.length ? footer : null
      )
    );
    root.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    const focusable = overlay.querySelector('input, textarea, select, button');
    if (focusable) focusable.focus();
  });
}

export async function confirmDialog(text, { danger = false, title = 'Confirm', confirmLabel = 'Confirm' } = {}) {
  const value = await modal({
    title,
    body: h('p', { class: 'modal-text', text }),
    actions: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, value: true, variant: danger ? 'danger' : 'primary' }
    ]
  });
  return value === true;
}

export async function promptDialog(title, label, value = '') {
  const input = h('input', { class: 'input', type: 'text', value: value === null || value === undefined ? '' : String(value), spellcheck: 'false' });
  const result = await modal({
    title,
    body: h('label', { class: 'field' }, h('span', { text: label }), input),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'OK', variant: 'primary', onClick: () => (input.value.trim() ? undefined : false) }
    ]
  });
  if (result === null || result === undefined) return null;
  return input.value;
}

export function formatBytes(value) {
  const n = Number(value);
  if (!isFinite(n) || n < 0) return '\u2014';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let size = n / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return (size >= 100 ? size.toFixed(0) : size.toFixed(1)) + ' ' + units[index];
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return days + 'd ' + hours + 'h ' + minutes + 'm';
  if (hours > 0) return hours + 'h ' + minutes + 'm';
  if (minutes > 0) return minutes + 'm ' + (total % 60) + 's';
  return total + 's';
}

export function formatDate(value) {
  if (value === null || value === undefined || value === '') return '\u2014';
  let date;
  if (typeof value === 'number') {
    date = new Date(value < 1e12 ? value * 1000 : value);
  } else {
    date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
  }
  if (isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes()) +
    ':' +
    pad(date.getSeconds())
  );
}

export function levelClass(percent) {
  const value = Number(percent) || 0;
  if (value < 60) return 'ok';
  if (value < 85) return 'warn';
  return 'danger';
}

export function progressBar(percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  return h(
    'div',
    { class: 'progress' },
    h('div', { class: 'progress-fill ' + levelClass(value), style: { width: value + '%' } })
  );
}

export function badge(text, kind = 'info') {
  return h('span', { class: 'badge badge-' + kind, text });
}

export function icon(name) {
  const paths = {
    dashboard: 'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z',
    terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
    files: 'M3 6h6l2 2h10v10H3z',
    accounts: 'M8 11a3 3 0 100-6 3 3 0 000 6zM2 20c0-3 2.7-5 6-5s6 2 6 5M17 11a3 3 0 100-6M16 20c0-2 .5-3.5 1.5-4.5',
    security: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z',
    settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2',
    logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h9'
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name] || paths.dashboard);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}
