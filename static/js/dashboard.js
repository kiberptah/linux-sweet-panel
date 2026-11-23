import { api } from './api.js';
import { h, toast, formatBytes, formatDuration, formatDate, levelClass } from './ui.js';

let root = null;
let timer = null;
let busy = false;
let lastError = '';
let onVisibility = null;
let cpu = null;
let ram = null;
let swapCard = null;
let uptimeCard = null;
let procBody = null;

function card(title) {
  const value = h('div', { class: 'card-value', text: '\u2014' });
  const meta = h('div', { class: 'card-meta', text: '' });
  const fill = h('div', { class: 'progress-fill ok', style: { width: '0%' } });
  const bar = h('div', { class: 'progress' }, fill);
  const el = h('div', { class: 'card' }, h('div', { class: 'card-title', text: title }), value, meta, bar);
  return { el, value, meta, bar, fill };
}

function setCard(target, valueText, metaText, percent) {
  target.value.textContent = valueText;
  target.meta.textContent = metaText;
  if (percent === null || percent === undefined) {
    target.bar.classList.add('hidden');
    return;
  }
  target.bar.classList.remove('hidden');
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  target.fill.style.width = pct + '%';
  target.fill.className = 'progress-fill ' + levelClass(pct);
}

function infoRow(label, value) {
  return [h('dt', { text: label }), h('dd', { text: value })];
}

export function mount(container, ctx) {
  root = h('div', { class: 'page' });
  container.appendChild(root);

  const links = h(
    'div',
    { class: 'quick-links' },
    h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => ctx.openWorkspace('terminal') }, 'Open Terminal'),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.openWorkspace('files') }, 'File Manager')
  );
  if (ctx.me && ctx.me.admin) {
    links.appendChild(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.navigate('accounts') }, 'Accounts'));
  }

  root.appendChild(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', { text: 'Dashboard' }), h('div', { class: 'sub', text: 'Live system overview, refreshed every 3 seconds' })),
      links
    )
  );

  cpu = card('CPU');
  ram = card('Memory');
  swapCard = card('Swap');
  uptimeCard = card('Uptime');
  root.appendChild(h('div', { class: 'grid grid-4' }, cpu.el, ram.el, swapCard.el, uptimeCard.el));

  const sysList = h('dl', { class: 'kv' });
  const sysCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title', text: 'System' })),
    sysList
  );

  const diskList = h('div', { class: 'grid', style: { gap: '10px' } });
  const diskCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title', text: 'Disks' })),
    diskList
  );
  root.appendChild(h('div', { class: 'grid grid-2', style: { marginTop: '14px' } }, sysCard, diskCard));

  procBody = h('tbody');
  const procCard = h(
    'div',
    { class: 'card', style: { marginTop: '14px', padding: '0' } },
    h('div', { class: 'card-head', style: { padding: '14px 16px 0' } }, h('div', { class: 'card-title', text: 'Top processes' })),
    h(
      'div',
      { class: 'table-wrap', style: { marginTop: '10px', border: 'none', borderRadius: '0 0 10px 10px' } },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { class: 'num', text: 'PID' }),
            h('th', { text: 'User' }),
            h('th', { class: 'num', text: 'CPU %' }),
            h('th', { class: 'num', text: 'MEM %' }),
            h('th', { class: 'num', text: 'RSS' }),
            h('th', { text: 'Command' })
          )
        ),
        procBody
      )
    )
  );
  root.appendChild(procCard);

  onVisibility = () => {
    if (document.visibilityState === 'visible') tick();
  };
  document.addEventListener('visibilitychange', onVisibility);

  tick();
  timer = setInterval(tick, 3000);
}

export function unmount() {
  if (timer) clearInterval(timer);
  timer = null;
  if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
  onVisibility = null;
  root = null;
  busy = false;
  lastError = '';
}

function render(stats) {
  const cpuPercent = Number(stats.cpu && stats.cpu.percent) || 0;
  const load = Array.isArray(stats.load) ? stats.load : [0, 0, 0];
  setCard(
    cpu,
    cpuPercent.toFixed(0) + '%',
    'load ' + load.map((value) => Number(value).toFixed(2)).join(' / ') + ' \u00b7 ' + (stats.cpu ? stats.cpu.cores : 0) + ' cores',
    cpuPercent
  );
  const mem = stats.mem || { total: 0, used: 0, available: 0, percent: 0 };
  setCard(
    ram,
    formatBytes(mem.used) + ' / ' + formatBytes(mem.total),
    (Number(mem.percent) || 0).toFixed(0) + '% used \u00b7 ' + formatBytes(mem.available) + ' available',
    mem.percent
  );
  const swap = stats.swap || { total: 0, used: 0, percent: 0 };
  if (swap.total > 0) {
    setCard(swapCard, formatBytes(swap.used) + ' / ' + formatBytes(swap.total), (Number(swap.percent) || 0).toFixed(0) + '% used', swap.percent);
  } else {
    setCard(swapCard, 'none', 'no swap configured', null);
  }
  setCard(uptimeCard, formatDuration(stats.uptime_s), 'since ' + formatDate(Date.now() / 1000 - (Number(stats.uptime_s) || 0)), null);

  sysList.textContent = '';
  for (const row of infoRow('Hostname', stats.hostname || '\u2014')) sysList.appendChild(row);
  for (const row of infoRow('OS', stats.os || '\u2014')) sysList.appendChild(row);
  for (const row of infoRow('Kernel', stats.kernel || '\u2014')) sysList.appendChild(row);

  diskList.textContent = '';
  const disks = Array.isArray(stats.disks) ? stats.disks : [];
  if (!disks.length) {
    diskList.appendChild(h('div', { class: 'empty', text: 'No filesystems reported' }));
  }
  for (const disk of disks) {
    const pct = Number(disk.percent) || 0;
    diskList.appendChild(
      h(
        'div',
        {},
        h(
          'div',
          { class: 'card-head', style: { marginBottom: '2px' } },
          h('div', { class: 'mono', text: disk.mount || '' }),
          h('div', { class: 'muted mono', text: formatBytes(disk.used) + ' / ' + formatBytes(disk.total) + ' \u00b7 ' + pct.toFixed(0) + '%' })
        ),
        h('div', { class: 'progress', style: { marginTop: '4px' } }, h('div', { class: 'progress-fill ' + levelClass(pct), style: { width: Math.max(0, Math.min(100, pct)) + '%' } })),
        h('div', { class: 'card-meta', text: (disk.device || '') + ' \u00b7 ' + (disk.fs || '') })
      )
    );
  }

  procBody.textContent = '';
  const procs = Array.isArray(stats.procs) ? stats.procs : [];
  if (!procs.length) {
    procBody.appendChild(h('tr', {}, h('td', { colspan: '6', class: 'empty', text: 'No processes reported' })));
  }
  for (const proc of procs) {
    procBody.appendChild(
      h(
        'tr',
        {},
        h('td', { class: 'num mono', text: proc.pid }),
        h('td', { text: proc.user }),
        h('td', { class: 'num mono', text: (Number(proc.cpu) || 0).toFixed(1) }),
        h('td', { class: 'num mono', text: (Number(proc.mem) || 0).toFixed(1) }),
        h('td', { class: 'num mono', text: formatBytes(proc.rss) }),
        h('td', {}, h('div', { class: 'truncate mono', title: proc.cmd || '', text: proc.cmd || '' }))
      )
    );
  }
}

async function tick() {
  if (!root || busy) return;
  if (document.visibilityState === 'hidden') return;
  busy = true;
  try {
    const stats = await api.get('/api/stats');
    if (!root) return;
    lastError = '';
    render(stats);
  } catch (err) {
    const message = err && err.message ? err.message : 'cannot load stats';
    if (message !== lastError && message !== 'not authenticated') {
      lastError = message;
      toast(message, 'danger');
    }
  } finally {
    busy = false;
  }
}
