// Sketch — simple canvas paint app with PNG export.
import { h } from '../core/dom.js';
import { icons } from '../core/icons.js';

const PALETTE = ['#111111', '#ffffff', '#ff3cac', '#7c5cff', '#00d4ff', '#3ddc97', '#ffd319', '#ff7a18', '#e81123'];

export default {
  mount(root, ctx) {
    let color = PALETTE[3];
    let size = 6;
    let tool = 'brush';
    const undo = [];
    const canvas = h('canvas', { width: 1200, height: 800 });
    const x = canvas.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, canvas.width, canvas.height);
    x.lineCap = x.lineJoin = 'round';

    const sizeIn = h('input', { type: 'range', min: 1, max: 60, value: size, style: { width: '110px' } });
    sizeIn.addEventListener('input', () => (size = +sizeIn.value));
    const swatches = PALETTE.map((c) => {
      const b = h(`button.pt-color${c === color ? '.active' : ''}`, { style: { background: c }, title: c });
      b.addEventListener('click', () => { color = c; tool = 'brush'; swatches.forEach((s) => s.classList.toggle('active', s === b)); syncTools(); });
      return b;
    });
    const brushBtn = h('button.tool-btn', { html: icons.brush, onclick: () => { tool = 'brush'; syncTools(); } }, 'Brush');
    const eraseBtn = h('button.tool-btn', { html: icons.eraser, onclick: () => { tool = 'eraser'; syncTools(); } }, 'Eraser');
    const syncTools = () => { brushBtn.classList.toggle('active', tool === 'brush'); eraseBtn.classList.toggle('active', tool === 'eraser'); };
    syncTools();

    root.append(h('div.app',
      h('div.app-toolbar', brushBtn, eraseBtn, h('span.sep'), ...swatches, h('span.sep'), 'Size', sizeIn, h('span.spacer'),
        h('button.tool-btn', { html: icons.undo, onclick: () => doUndo() }, 'Undo'),
        h('button.tool-btn', { html: icons.trash, onclick: () => { snapshot(); x.fillStyle = '#fff'; x.fillRect(0, 0, canvas.width, canvas.height); } }, 'Clear'),
        h('button.tool-btn', { html: icons.download, onclick: () => h('a', { href: canvas.toDataURL('image/png'), download: 'sketch.png' }).click() }, 'Export'),
      ),
      h('div.pt-wrap', canvas),
    ));

    const snapshot = () => { undo.push(x.getImageData(0, 0, canvas.width, canvas.height)); if (undo.length > 25) undo.shift(); };
    const doUndo = () => { const s = undo.pop(); if (s) x.putImageData(s, 0, 0); };
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
    };
    canvas.addEventListener('pointerdown', (e) => {
      snapshot();
      canvas.setPointerCapture(e.pointerId);
      let [lx, ly] = pos(e);
      x.strokeStyle = tool === 'eraser' ? '#fff' : color;
      x.lineWidth = tool === 'eraser' ? size * 3 : size;
      x.beginPath();
      x.arc(lx, ly, x.lineWidth / 2, 0, Math.PI * 2);
      x.fillStyle = x.strokeStyle;
      x.fill();
      const move = (ev) => {
        const [nx, ny] = pos(ev);
        x.beginPath();
        x.moveTo(lx, ly);
        x.lineTo(nx, ny);
        x.stroke();
        [lx, ly] = [nx, ny];
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', () => canvas.removeEventListener('pointermove', move), { once: true });
    });
    const onKey = (e) => { if (ctx.win.isFocused() && e.ctrlKey && e.key === 'z') { e.preventDefault(); doUndo(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  },
};
