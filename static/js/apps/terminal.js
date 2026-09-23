// Terminal — a tiny shell that talks to the LTF kernel API.
import { h, escapeHtml, formatBytes } from '../core/dom.js';
import { registry } from '../core/registry.js';
import { store } from '../core/store.js';

const LOGO = [
  '       /\\',
  '      /  \\          ninja@ltf-os',
  '     /\\   \\         ------------',
  '    /  __  \\        OS: %OS%',
  '   /  (  )  \\       Kernel: %KERNEL%',
  '  / __|  |__\\      Uptime: %UPTIME%',
  " /.'        '.\\     Shell: ltfsh 0.9",
  '                    WM: LTF Compositor (Mica)',
  '                    Theme: %THEME%',
  '                    CPU: %CPU%',
  '                    GPU: %GPU%',
  '                    Memory: %MEM%',
  '                    Haircut: Low taper fade',
].join('\n');

export default {
  mount(root, ctx) {
    const { api } = ctx;
    const out = h('div');
    const input = h('input', { spellcheck: false, autocomplete: 'off', 'aria-label': 'Command' });
    const promptEl = () => h('span', { html: '<span class="prompt">ninja@ltf-os</span>:<span class="path">~</span>$' });
    const term = h('div.term', out, h('div.input-line', promptEl(), input));
    root.append(term);
    const history = [];
    let hIdx = 0;
    let cwd = '~';

    const print = (html, cls = '') => { out.append(h(`div.line${cls ? `.${cls}` : ''}`, { html })); term.scrollTop = term.scrollHeight; };
    const text = (t, cls) => print(escapeHtml(t), cls);

    const commands = {
      help: () => text([
        'Available commands:',
        '  help                 show this help',
        '  ls                   list files on the LTF drive',
        '  cat <file>           print a file',
        '  rm <file>            delete a file',
        '  touch <file>         create an empty file',
        '  echo <text> > <file> write text to a file',
        '  open <app|file>      launch an app or open a file in Notepad',
        '  apps                 list installed apps',
        '  pacman -S <app>      install an app   (pacman -R to remove)',
        '  neofetch             system information',
        '  top                  live resource snapshot',
        '  theme <#hex>         change accent colour',
        '  taskbar <edge>       move taskbar: top|bottom|left|right',
        '  date, whoami, uptime, clear, exit',
      ].join('\n')),
      clear: () => out.replaceChildren(),
      exit: () => ctx.win.close(),
      whoami: () => text('ninja'),
      date: () => text(new Date().toString()),
      pwd: () => text(cwd === '~' ? '/home/ninja' : cwd),
      echo: (args, raw) => {
        const m = raw.match(/^echo\s+(.*?)\s*>\s*(\S+)$/);
        if (m) return api.files.write(m[2], `${m[1].replace(/^["']|["']$/g, '')}\n`).then(() => {}).catch((e) => text(e.message, 'err'));
        text(args.join(' '));
      },
      async ls() {
        const files = await api.files.list();
        if (!files.length) return text('(empty)');
        print(files.map((f) => `<span class="accent">${escapeHtml(f.name)}</span>  <span style="color:#777">${formatBytes(f.size)}</span>`).join('\n'));
      },
      async cat([name]) {
        if (!name) return text('usage: cat <file>', 'err');
        text(await api.files.read(name));
      },
      async rm([name]) {
        if (!name) return text('usage: rm <file>', 'err');
        await api.files.remove(name);
      },
      async touch([name]) {
        if (!name) return text('usage: touch <file>', 'err');
        await api.files.write(name, '');
      },
      open([target]) {
        if (!target) return text('usage: open <app|file>', 'err');
        const app = registry.all().find((a) => a.id === target || a.name.toLowerCase() === target.toLowerCase());
        if (app) return ctx.open(app.id);
        ctx.open('notepad', { file: target });
      },
      apps: () => text(registry.all().map((a) => `${a.installed ? '[x]' : '[ ]'} ${a.id.padEnd(12)} ${a.name}`).join('\n')),
      async pacman([flag, id]) {
        if (flag === '-Syu') {
          for (const l of [':: Synchronizing package databases...', ' core is up to date', ' extra is up to date', ' fade is up to date', ':: Starting full system upgrade...', ' there is nothing to do']) {
            text(l);
            await new Promise((r) => setTimeout(r, 180));
          }
          return;
        }
        if (!id || !['-S', '-R'].includes(flag)) return text('usage: pacman -S <app> | -R <app> | -Syu', 'err');
        if (!registry.get(id)) return text(`error: target not found: ${id}`, 'err');
        text(`resolving dependencies...\nlooking for conflicting packages...\n(1/1) ${flag === '-S' ? 'installing' : 'removing'} ${id}`);
        if (flag === '-S') await registry.install(id);
        else await registry.uninstall(id);
        text(':: done', 'accent');
      },
      async neofetch() {
        const info = await api.get('/system/info').catch(() => ({}));
        const m = await api.get('/system/stats').catch(() => ({}));
        const mins = Math.floor((info.uptime_secs || 0) / 60);
        const logo = LOGO
          .replace('%OS%', `${info.name || 'LTF OS'} ${info.version || ''} (${info.codename || 'offline'})`)
          .replace('%KERNEL%', info.kernel || 'unknown')
          .replace('%UPTIME%', `${mins} mins`)
          .replace('%THEME%', `${store.get('theme.mode')} · accent ${store.get('theme.accent')}`)
          .replace('%CPU%', info.cpu || 'unknown')
          .replace('%GPU%', info.gpu || 'unknown')
          .replace('%MEM%', m.ram_used_mb ? `${Math.round(m.ram_used_mb)}MiB / ${m.ram_total_mb}MiB` : 'unknown');
        print(`<span style="color:#1793d1">${escapeHtml(logo)}</span>`);
      },
      async top() {
        const m = await api.get('/system/stats');
        const bar = (v) => `[${'|'.repeat(Math.round(v / 5)).padEnd(20)}] ${v.toFixed(1)}%`;
        text(m.cores.map((c, i) => `CPU${i}  ${bar(c)}`).join('\n') + `\nMem   ${bar((m.ram_used_mb / m.ram_total_mb) * 100)}\nGPU   ${bar(m.gpu)}\nTasks ${m.processes}  Temp ${m.temp_c.toFixed(0)}°C`);
      },
      async uptime() {
        const info = await api.get('/system/info');
        text(`up ${Math.floor(info.uptime_secs / 60)} min, 1 user, load average: 0.42, 0.37, 0.31`);
      },
      theme([hex]) {
        if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return text('usage: theme #rrggbb', 'err');
        store.set('theme.accent', hex);
      },
      taskbar([edge]) {
        if (!['top', 'bottom', 'left', 'right'].includes(edge)) return text('usage: taskbar top|bottom|left|right', 'err');
        store.set('taskbar.position', edge);
      },
      sudo: () => text('ninja is not in the sudoers file. This incident will be reported to the barber.', 'err'),
      fade: () => text('✂  Applying low taper fade… done. Massive.', 'accent'),
      cd: ([d]) => { cwd = !d || d === '~' ? '~' : d; },
    };

    async function run(raw) {
      print(`<span class="prompt">ninja@ltf-os</span>:<span class="path">${escapeHtml(cwd)}</span>$ ${escapeHtml(raw)}`);
      const [cmd, ...args] = raw.trim().split(/\s+/);
      if (!cmd) return;
      const fn = commands[cmd];
      if (!fn) return text(`ltfsh: command not found: ${cmd}`, 'err');
      try {
        await fn(args, raw.trim());
      } catch (e) {
        text(`${cmd}: ${e.message}`, 'err');
      }
    }

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const v = input.value;
        input.value = '';
        if (v.trim()) history.push(v);
        hIdx = history.length;
        await run(v);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (hIdx > 0) input.value = history[--hIdx];
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        hIdx = Math.min(history.length, hIdx + 1);
        input.value = history[hIdx] || '';
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const match = Object.keys(commands).find((c) => c.startsWith(input.value));
        if (match) input.value = `${match} `;
      } else if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        commands.clear();
      }
    });
    term.addEventListener('click', () => { if (!getSelection().toString()) input.focus(); });

    run('neofetch').then(() => text('Type "help" for a list of commands.'));
    setTimeout(() => input.focus(), 50);
    return { onFocus: () => input.focus() };
  },
};
