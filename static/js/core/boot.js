// Arch Linux–style boot console (kernel + systemd unit output).
// Resolves once both the log animation and the real init work are done.

import { $, escapeHtml, local } from './dom.js';

const PRELUDE = [
  ['arch', 'Orion OS Boot Manager'],
  ['dim', '  Loading Orion OS (linux)'],
  ['', ':: Loading Linux linux ...'],
  ['', ':: Loading initial ramdisk ...'],
  ['', '[    0.000000] Linux version 6.10.10-arch1-1 (linux@archlinux) (gcc (GCC) 14.2.1, GNU ld 2.43) #1 SMP PREEMPT_DYNAMIC'],
  ['', '[    0.000000] Command line: initrd=\\initramfs-linux.img root=UUID=5c1f7c2e-3b7e-4d2a-9f4e-2a1d6c0b8e11 rw quiet splash'],
  ['dim', '[    0.004211] x86/fpu: Supporting XSAVE feature 0x001: \'x87 floating point registers\''],
  ['dim', '[    0.093310] ACPI: Early table checksum verification disabled'],
  ['dim', '[    0.412806] PCI: Using configuration type 1 for base access'],
  ['dim', '[    1.022417] nvme nvme0: 16/0/0 default/read/poll queues'],
  ['', ':: running early hook [udev]'],
  ['', 'Starting systemd-udevd version 256.7-1-arch'],
  ['', ':: running hook [udev]'],
  ['', ':: Triggering uevents...'],
  ['', ':: running hook [keymap]'],
  ['', ':: performing fsck on \'/dev/nvme0n1p2\''],
  ['', '/dev/nvme0n1p2: clean, 482311/30531584 files, 9187723/122096646 blocks'],
  ['', ':: mounting \'/dev/nvme0n1p2\' on real root'],
  ['', ''],
  ['', 'Welcome to <b class="arch">Orion OS</b>!'],
  ['', ''],
];

const FALLBACK_UNITS = [
  ['ok', 'Reached target Local File Systems.'],
  ['ok', 'Reached target System Initialization.'],
  ['ok', 'Reached target Basic System.'],
  ['fail', 'Failed to start Orion OS API Server (connection refused).'],
  ['warn', 'Continuing in offline mode; preferences are stored locally.'],
  ['ok', 'Loaded Application Registry.'],
  ['ok', 'Started Display Compositor.'],
  ['ok', 'Reached target Graphical Interface.'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runBoot(work) {
  const boot = $('#boot');
  const log = $('#boot-log');
  const pct = $('#boot-percent');
  const bar = $('#boot-bar-fill');
  const status = $('#boot-status');
  let skipped = local.get('prefs')?.boot?.skipAnimation === true;

  const skip = (e) => {
    if (e.type === 'click' || e.key === 'Escape' || e.key === 'Enter') skipped = true;
  };
  window.addEventListener('keydown', skip);
  boot.addEventListener('click', skip);

  let units = null;
  const unitsP = fetch('/api/system/boot-log').then((r) => (r.ok ? r.json() : null)).then((u) => (units = u)).catch(() => null);

  let workDone = false;
  const workP = Promise.resolve().then(work).finally(() => (workDone = true));

  const lines = [];
  const cursor = '<span class="cursor"></span>';
  const render = () => {
    log.innerHTML = lines.slice(-60).join('') + `<div>${cursor}</div>`;
  };
  const push = (cls, text, html = false) => {
    const body = html ? text : escapeHtml(text);
    // One block per line: #boot-log is a flex column anchored to the bottom.
    lines.push(`<div${cls ? ` class="${cls}"` : ''}>${body || '&nbsp;'}</div>`);
    render();
  };
  const tag = (s) => (s === 'ok' ? '[  <span class="ok">OK</span>  ]' : s === 'warn' ? '[ <span class="warn">WARN</span> ]' : '[<span class="fail">FAILED</span>]');
  const progress = (p, msg) => {
    const v = Math.round(Math.min(100, p));
    pct.textContent = `${v}%`;
    bar.style.width = `${v}%`;
    if (msg) status.textContent = msg;
  };

  // Phase 1 — bootloader + kernel
  for (let i = 0; i < PRELUDE.length; i++) {
    const [cls, text] = PRELUDE[i];
    push(cls, text, text.includes('<b'));
    progress((i / PRELUDE.length) * 30, 'loading kernel');
    if (!skipped) await sleep(40 + Math.random() * 60);
  }

  // Phase 2 — systemd units
  await Promise.race([unitsP, sleep(skipped ? 0 : 800)]);
  const list = units ? units.map((u) => [u.status, u.msg]) : FALLBACK_UNITS;
  for (let i = 0; i < list.length; i++) {
    const [s, msg] = list[i];
    // systemd prints the in-progress line first: Starting X... → Started/Finished X,
    // Mounting X... → Mounted X.
    const m = msg.match(/^(Started|Finished|Mounted) (.*)\.$/);
    if (m && !skipped) {
      push('', `         ${m[1] === 'Mounted' ? 'Mounting' : 'Starting'} ${m[2]}...`);
      await sleep(40 + Math.random() * 60);
    }
    push('', `${tag(s)} ${escapeHtml(msg)}`, true);
    progress(30 + (i / list.length) * 60, msg.toLowerCase().replace(/\.$/, ''));
    if (!skipped) await sleep(60 + Math.random() * 140);
  }

  // Phase 3 — wait for real work (prefs, registry, desktop)
  if (!workDone) {
    push('', `         Starting Orion OS Desktop Session...`);
    let p = 90;
    while (!workDone) {
      progress((p = Math.min(99, p + 1)), 'starting desktop session');
      await sleep(60);
    }
  }
  await workP.catch((err) => {
    console.error(err);
    push('', `${tag('fail')} Failed to start Orion OS Desktop Session: ${escapeHtml(err.message)}`, true);
  });

  const user = escapeHtml(local.get('prefs')?.user?.name || 'user');
  push('', '');
  push('', 'Orion OS (tty1)');
  push('', '');
  push('', `ltf login: <b>${user.toLowerCase().replace(/\s+/g, '')}</b> (automatic login)`, true);
  progress(100, 'starting session');
  window.removeEventListener('keydown', skip);
  await sleep(skipped ? 150 : 650);

  // Crossfade into the desktop
  boot.classList.add('fade-out');
  document.body.classList.remove('booting');
  await sleep(900);
  boot.remove();
}
