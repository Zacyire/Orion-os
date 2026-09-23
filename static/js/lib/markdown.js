// Minimal, safe Markdown → HTML renderer (headings, emphasis, code, lists,
// quotes, links, images, rules, tables). Input is HTML-escaped first.
import { escapeHtml } from '../core/dom.js';

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => safeUrl(src) ? `<img alt="${alt}" src="${src}">` : alt)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => safeUrl(href) ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>` : text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

const safeUrl = (u) => /^(https?:|mailto:|\/|#|assets\/)/i.test(u.replace(/&amp;/g, '&'));

export function renderMarkdown(src) {
  const lines = escapeHtml(src).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr>');
    } else if (/^&gt;\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"))}</blockquote>`);
      continue;
    } else if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const buf = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const item = lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, '');
        const task = item.match(/^\[([ xX])\]\s+(.*)$/);
        buf.push(task ? `<li><input type="checkbox" disabled ${task[1] !== ' ' ? 'checked' : ''}> ${inline(task[2])}</li>` : `<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${buf.join('')}</ol>` : `<ul>${buf.join('')}</ul>`);
      continue;
    } else if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (l) => l.trim().slice(1, -1).split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    } else if (line.trim() === '') {
      // paragraph break
    } else {
      const buf = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#|```|&gt;|\s*[-*+]\s|\s*\d+\.\s|\|)/.test(lines[i + 1])) buf.push(lines[++i]);
      out.push(`<p>${inline(buf.join(' '))}</p>`);
    }
    i++;
  }
  return out.join('\n');
}
