// Files — browse the LTF drive (server-side documents).
import { h, formatBytes } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { contextMenu } from '../core/contextmenu.js';

export default {
  mount(root, ctx) {
    const { api, notify } = ctx;
    let view = 'drive';
    let files = [];
    let sel = null;
    let sort = { key: 'modified', dir: -1 };

    const nav = h('nav.app-sidebar');
    const main = h('div.app-main', { style: { padding: '0' } });
    const status = h('span');
    const pathEl = h('div.field', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: 1, maxWidth: '520px' } });
    const upload = h('input', { type: 'file', multiple: true, hidden: true });

    root.append(h('div.app',
      h('div.app-toolbar',
        h('button.tool-btn', { onclick: () => upload.click(), html: icons.upload }, 'Upload'),
        h('button.tool-btn', { onclick: () => newFile(), html: icons.plus }, 'New'),
        h('button.tool-btn', { onclick: () => load(), html: icons.refresh }, 'Refresh'),
        h('span.sep'), pathEl, upload,
      ),
      h('div.app-row', nav, main),
      h('div.app-status', status, h('span.spacer'), h('span', 'LTF drive (data/files)')),
    ));

    const navItem = (id, icon, label) => {
      const b = h(`button.nav-item${view === id ? '.active' : ''}`, { html: icons[icon] }, label);
      b.addEventListener('click', () => { view = id; draw(); });
      return b;
    };

    async function load() {
      try {
        files = await api.files.list();
      } catch {
        files = null;
      }
      draw();
    }

    async function newFile() {
      const name = prompt('New file name', 'notes.md');
      if (!name) return;
      try {
        await api.files.write(name, '');
        await load();
        ctx.open('notepad', { file: name });
      } catch (e) { notify('Could not create file', e.message, { type: 'error' }); }
    }

    async function remove(name) {
      if (!confirm(`Delete ${name}?`)) return;
      try {
        await api.files.remove(name);
        notify('Deleted', name);
        load();
      } catch (e) { notify('Delete failed', e.message, { type: 'error' }); }
    }

    async function doUpload(list) {
      if (!list.length) return;
      try {
        await api.files.upload(list);
        notify('Uploaded', `${list.length} file(s)`, { type: 'success' });
        load();
      } catch (e) { notify('Upload failed', e.message, { type: 'error' }); }
    }
    upload.addEventListener('change', () => { doUpload([...upload.files]); upload.value = ''; });

    function drawDrive() {
      const used = (files || []).reduce((a, f) => a + f.size, 0);
      const total = 256 * 1024 ** 3;
      return h('div', { style: { padding: '20px 26px' } },
        h('h1.page-title', 'This PC'),
        h('div.section-title', 'Devices and drives'),
        h('div.card.drive-card', { style: { maxWidth: '380px', cursor: 'pointer' }, onclick: () => { view = 'docs'; draw(); } },
          h('span', { html: icons.drive }),
          h('div', { style: { flex: 1 } }, h('b', 'LTF Drive (C:)'),
            h('div.w-bar', h('i', { style: { width: `${Math.max(2, (used / total) * 100 + 34)}%` } })),
            h('small.muted', `${formatBytes(total - used - total * 0.34)} free of 256 GB`)),
        ),
        h('div.section-title', 'Quick access'),
        h('div', { style: { display: 'flex', gap: '10px' } },
          ...[['docs', 'folder', 'Documents'], ['music', 'music', 'Music'], ['videos', 'movies', 'Videos']].map(([id, ic, label]) =>
            h('button.card', { style: { display: 'flex', gap: '10px', alignItems: 'center', width: '160px' }, onclick: () => (id === 'docs' ? (view = 'docs', draw()) : ctx.open(id === 'music' ? 'music' : 'movies')) },
              h('span', { html: icons[ic], style: { width: '22px', color: 'var(--accent-2)' } }), label)),
        ),
      );
    }

    function drawDocs() {
      if (files === null) return h('div.empty', h('span', { html: icons.wifiOff, style: { width: '40px' } }), 'The kernel is offline — the LTF drive is unavailable.');
      if (!files.length) return h('div.empty', 'This folder is empty. Drop files here to upload.');
      const sorted = [...files].sort((a, b) => (a[sort.key] > b[sort.key] ? 1 : -1) * sort.dir);
      const th = (key, label) => h('th', { style: { cursor: 'pointer' }, onclick: () => { sort = { key, dir: sort.key === key ? -sort.dir : 1 }; draw(); } }, label, sort.key === key ? (sort.dir > 0 ? ' ▲' : ' ▼') : '');
      return h('table.ex-table',
        h('thead', h('tr', th('name', 'Name'), th('modified', 'Date modified'), th('size', 'Size'))),
        h('tbody', sorted.map((f) => {
          const tr = h(`tr.file-row${sel === f.name ? '.sel' : ''}`,
            h('td', h('span', { html: /\.md$/i.test(f.name) ? icons.notepad : icons.file }), f.name),
            h('td.muted', new Date(f.modified).toLocaleString()),
            h('td.muted', formatBytes(f.size)),
          );
          tr.addEventListener('click', () => { sel = f.name; draw(); });
          tr.addEventListener('dblclick', () => ctx.open('notepad', { file: f.name }));
          tr.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            sel = f.name;
            draw();
            contextMenu.open(e.clientX, e.clientY, [
              { label: 'Open in Notepad', icon: 'notepad', action: () => ctx.open('notepad', { file: f.name }) },
              { label: 'Download', icon: 'download', action: () => h('a', { href: api.files.downloadUrl(f.name), download: f.name }).click() },
              '-',
              { label: 'Delete', icon: 'trash', danger: true, action: () => remove(f.name) },
            ]);
          });
          return tr;
        })),
      );
    }

    function draw() {
      nav.replaceChildren(navItem('drive', 'desktop', 'This PC'), navItem('docs', 'folder', 'Documents'));
      pathEl.replaceChildren(h('span', { html: icons.folder, style: { width: '16px' } }), view === 'drive' ? 'This PC' : 'This PC › LTF Drive (C:) › Documents');
      main.replaceChildren(view === 'drive' ? drawDrive() : drawDocs());
      status.textContent = files ? `${files.length} items${sel ? ' · 1 selected' : ''}` : 'offline';
      ctx.win.setTitle(view === 'drive' ? 'This PC — Files' : 'Documents — Files');
    }

    main.addEventListener('dragover', (e) => { e.preventDefault(); main.classList.add('ex-drop'); });
    main.addEventListener('dragleave', () => main.classList.remove('ex-drop'));
    main.addEventListener('drop', (e) => { e.preventDefault(); main.classList.remove('ex-drop'); view = 'docs'; doUpload([...e.dataTransfer.files]); });

    const off = ctx.bus.on('server:file-changed', () => load());
    load();
    return off;
  },
};
