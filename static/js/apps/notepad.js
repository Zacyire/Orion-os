// Notepad — plain text / Markdown editor with server-side storage
// (Rust /api/files), upload, download and local draft persistence.
import { h, debounce, local, formatBytes } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { renderMarkdown } from '../lib/markdown.js';

export default {
  mount(root, ctx) {
    const { api, notify, win } = ctx;
    let file = null;        // server file name
    let saved = '';         // last saved content
    let preview = false;
    let wrap = true;

    const ta = h('textarea', { spellcheck: false, placeholder: 'Start typing… (Markdown supported)' });
    const pv = h('div.np-preview', { hidden: true });
    const editor = h('div.np-editor', ta, pv);
    const status = { pos: h('span'), count: h('span'), kind: h('span'), state: h('span') };
    const upload = h('input', { type: 'file', accept: '.txt,.md,.markdown,.json,.csv,.log,.js,.rs,.html,.css,text/*', hidden: true, multiple: true });

    const btn = (icon, label, onclick, title) => h('button.tool-btn', { onclick, title: title || label }, h('span', { html: icons[icon] }), label);
    const pvBtn = btn('eye', 'Preview', () => togglePreview());
    const wrapBtn = btn('list', 'Wrap', () => { wrap = !wrap; editor.classList.toggle('wrap-off', !wrap); wrapBtn.classList.toggle('active', wrap); });
    wrapBtn.classList.add('active');

    root.append(h('div.app',
      h('div.app-toolbar',
        btn('plus', 'New', () => newDoc()),
        btn('open', 'Open', (e) => showFiles(e.currentTarget)),
        btn('save', 'Save', () => save(), 'Save (Ctrl+S)'),
        btn('edit', 'Save as', () => save(true)),
        h('span.sep'),
        btn('upload', 'Upload', () => upload.click()),
        btn('download', 'Download', () => download()),
        h('span.sep'),
        pvBtn, wrapBtn,
        upload,
      ),
      editor,
      h('div.app-status', status.pos, status.count, h('span.spacer'), status.state, status.kind, h('span', 'UTF-8')),
    ));

    const isDirty = () => ta.value !== saved;
    const kind = () => (/\.(md|markdown)$/i.test(file || '') ? 'Markdown' : file ? 'Plain text' : 'Markdown');

    function updateTitle() {
      win.setTitle(`${isDirty() ? '● ' : ''}${file || 'Untitled'} — Notepad`);
    }

    function updateStatus() {
      const before = ta.value.slice(0, ta.selectionStart);
      const ln = before.split('\n').length;
      const col = before.length - before.lastIndexOf('\n');
      const words = (ta.value.match(/\S+/g) || []).length;
      status.pos.textContent = `Ln ${ln}, Col ${col}`;
      status.count.textContent = `${ta.value.length} chars · ${words} words`;
      status.kind.textContent = kind();
      status.state.textContent = file ? (isDirty() ? 'Unsaved changes' : 'Saved to LTF drive') : 'Draft';
      updateTitle();
    }

    const renderPreview = debounce(() => { if (preview) pv.innerHTML = renderMarkdown(ta.value); }, 120);
    const saveDraft = debounce(() => { if (!file) local.set('notepad:draft', ta.value); }, 400);

    function togglePreview(force) {
      preview = force ?? !preview;
      pv.hidden = !preview;
      pvBtn.classList.toggle('active', preview);
      if (preview) pv.innerHTML = renderMarkdown(ta.value);
    }

    function setDoc(name, text) {
      file = name;
      ta.value = saved = text;
      if (name && /\.(md|markdown)$/i.test(name)) togglePreview(true);
      updateStatus();
      renderPreview();
    }

    function newDoc() {
      if (isDirty() && ta.value && !confirm('Discard unsaved changes?')) return;
      setDoc(null, '');
      local.set('notepad:draft', '');
      togglePreview(false);
      ta.focus();
    }

    async function openFile(name) {
      try {
        setDoc(name, await api.files.read(name));
      } catch (e) {
        notify('Could not open file', e.message, { type: 'error' });
      }
    }

    async function save(as = false) {
      let name = file;
      if (!name || as) {
        name = prompt('Save as (letters, numbers, spaces, - _ .)', file || 'untitled.md');
        if (!name) return;
        if (!/\.[a-z0-9]+$/i.test(name)) name += '.txt';
      }
      try {
        await api.files.write(name, ta.value);
        file = name;
        saved = ta.value;
        local.set('notepad:draft', '');
        updateStatus();
        notify('Saved', `${name} · ${formatBytes(new Blob([ta.value]).size)}`, { type: 'success', timeout: 1800 });
      } catch (e) {
        notify('Save failed', `${e.message}. Your text is kept as a local draft.`, { type: 'error' });
        local.set('notepad:draft', ta.value);
      }
    }

    function download() {
      if (file && !isDirty()) {
        const a = h('a', { href: api.files.downloadUrl(file), download: file });
        a.click();
        return;
      }
      const blob = new Blob([ta.value], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      h('a', { href: url, download: file || 'untitled.txt' }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    upload.addEventListener('change', async () => {
      const files = [...upload.files];
      upload.value = '';
      if (!files.length) return;
      try {
        await api.files.upload(files);
        notify('Uploaded', files.map((f) => f.name).join(', '), { type: 'success' });
        openFile(files[0].name);
      } catch (e) {
        // Backend unavailable → still open the first file locally.
        notify('Upload failed', `${e.message}. Opened locally instead.`, { type: 'error' });
        setDoc(null, await files[0].text());
        saved = '';
        updateStatus();
      }
    });

    let popup;
    async function showFiles(anchor) {
      if (popup) { popup.remove(); popup = null; return; }
      popup = h('div.np-files.glass', h('div.muted', { style: { padding: '6px 10px', fontSize: 'var(--fs-xs)' } }, 'LTF drive'));
      root.querySelector('.app').append(popup);
      popup.style.left = `${anchor.offsetLeft}px`;
      try {
        const list = await api.files.list();
        if (!list.length) popup.append(h('div.empty', 'No files yet'));
        for (const f of list) {
          popup.append(h('button', { onclick: () => { popup.remove(); popup = null; if (!isDirty() || confirm('Discard unsaved changes?')) openFile(f.name); } },
            h('span', f.name), h('small', formatBytes(f.size))));
        }
      } catch {
        popup.append(h('div.empty', 'Server offline'));
      }
    }
    const closePopup = (e) => { if (popup && !popup.contains(e.target) && !e.target.closest('.tool-btn')) { popup.remove(); popup = null; } };
    root.addEventListener('pointerdown', closePopup);

    ta.addEventListener('input', () => { updateStatus(); renderPreview(); saveDraft(); });
    ta.addEventListener('keyup', updateStatus);
    ta.addEventListener('click', updateStatus);
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save(e.shiftKey);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    });
    // Drop files straight into the editor.
    ta.addEventListener('dragover', (e) => e.preventDefault());
    ta.addEventListener('drop', async (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      setDoc(null, await f.text());
      saved = '';
      updateStatus();
    });

    if (ctx.args.file) openFile(ctx.args.file);
    else setDoc(null, local.get('notepad:draft', '') || '');
    setTimeout(() => ta.focus(), 50);

    return {
      onFocus: () => ta.focus(),
      beforeClose: () => !(file && isDirty()) || confirm(`Close without saving ${file}?`),
    };
  },
};
