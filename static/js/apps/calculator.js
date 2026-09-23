// Calculator — standard calculator with keyboard support.
import { h } from '../core/dom.js';

export default {
  size: [340, 520],

  mount(root, ctx) {
    let expr = '';
    let result = '0';
    let fresh = false;
    const exprEl = h('small');
    const resEl = h('div', '0');
    const keys = h('div.calc-keys');
    root.append(h('div.calc', h('div.calc-display', exprEl, resEl), keys));

    const safeEval = (s) => {
      if (!/^[\d+\-*/().%\s]*$/.test(s)) throw new Error('bad input');
      const v = Function(`"use strict"; return (${s.replace(/%/g, '/100')})`)();
      if (!isFinite(v)) throw new Error('∞');
      return +v.toPrecision(12);
    };

    function press(k) {
      if (k === 'C') { expr = ''; result = '0'; }
      else if (k === '⌫') expr = expr.slice(0, -1);
      else if (k === '=') {
        try {
          result = String(safeEval(expr || '0'));
          exprEl.textContent = `${expr} =`;
          expr = result;
          fresh = true;
        } catch { result = 'Error'; }
        return render(true);
      } else if (k === '±') expr = expr.startsWith('-') ? expr.slice(1) : `-${expr}`;
      else {
        if (fresh && /[\d.]/.test(k)) expr = '';
        expr += k === '×' ? '*' : k === '÷' ? '/' : k === '−' ? '-' : k;
      }
      fresh = false;
      render();
    }

    function render(final = false) {
      if (!final) {
        exprEl.textContent = expr.replace(/\*/g, '×').replace(/\//g, '÷');
        try { result = expr ? String(safeEval(expr)) : '0'; } catch { /* partial expression */ }
      }
      resEl.textContent = result;
    }

    ['%', 'C', '⌫', '÷', '7', '8', '9', '×', '4', '5', '6', '−', '1', '2', '3', '+', '±', '0', '.', '='].forEach((k) => {
      const cls = k === '=' ? '.eq' : /[%C⌫÷×−+±]/.test(k) ? '.op' : '';
      keys.append(h(`button${cls}`, { onclick: () => press(k) }, k));
    });

    const onKey = (e) => {
      if (!ctx.win.isFocused()) return;
      const map = { Enter: '=', '=': '=', Backspace: '⌫', Escape: 'C', '*': '×', '/': '÷', '-': '−' };
      const k = map[e.key] || (/^[\d.+%()]$/.test(e.key) ? e.key : null);
      if (k) { e.preventDefault(); press(k); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  },
};
