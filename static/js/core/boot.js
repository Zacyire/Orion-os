// Arch Linux–style boot sequence with the Ninja Low Taper Fade spinner.
// Resolves once both the log animation and the real init work are done.

import { $, escapeHtml, local } from './dom.js';

const PRELUDE = [
  ['arch', 'LTF OS Boot Manager (systemd-boot 256.7-1-ltf)'],
  ['dim', '  Booting `LTF OS (linux-ltf)`'],
  ['', ':: Loading Linux linux-ltf ...'],
  ['', ':: Loading initial ramdisk ...'],
  ['', '[    0.000000] Linux version 6.9.7-ltf1-1 (ninja@taper) (rustc 1.94.1) #1 SMP PREEMPT_DYNAMIC'],
  ['', '[    0.000000] Command line: initrd=\\initramfs-linux-ltf.img root=/dev/ltf0 rw quiet fade=low taper=1'],
  ['dim', '[    0.004211] x86/fpu: Supporting XSAVE feature 0x001: \'x87 floating point registers\''],
  ['dim', '[    0.093310] ACPI: Early table checksum verification disabled'],
  ['', 'starting version 256.7-1-ltf'],
  ['', ':: running early hook [udev]'],
  ['', ':: running hook [udev]'],
  ['', ':: Triggering uevents...'],
  ['', ':: running hook [keymap]'],
  ['', '/dev/ltf0: clean, 482311/30531584 files, 9187723/122096646 blocks'],
  ['', ''],
  ['', 'Welcome to <b class="arch">LTF OS</b>!'],
  ['', ''],
];

const FALLBACK_UNITS = [
  ['ok', 'Reached target Local File Systems.'],
  ['ok', 'Started LTF OS Kernel.'],
  ['ok', 'Reached target System Initialization.'],
  ['ok', 'Started Compositor (Mica/Acrylic backend).'],
  ['warn', 'Kernel API unreachable — continuing in offline mode.'],
  ['ok', 'Loaded App Registry.'],
  ['ok', 'Started Ninja Hairline Service.'],
  ['ok', 'Reached target Graphical Interface.'],
];

const BANNER = String.raw`
   _    _____ _____    ___  ____
  | |  |_   _|  ___|  / _ \/ ___|
  | |    | | | |_    | | | \___ \
  | |___ | | |  _|   | |_| |___) |
  |_____||_| |_|      \___/|____/   low taper fade edition`;

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
    log.innerHTML = lines.slice(-60).join('\n') + '\n' + cursor;
  };
  const push = (cls, text, html = false) => {
    const body = html ? text : escapeHtml(text);
    lines.push(cls ? `<span class="${cls}">${body}</span>` : body);
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
    if (s === 'ok' && i % 3 === 0 && !skipped) {
      push('', `         Starting ${msg.replace(/^(Started|Reached target|Loaded|Mounted|Listening on) /, '').replace(/\.$/, '')}...`);
      await sleep(70 + Math.random() * 90);
    }
    push('', `${tag(s)} ${escapeHtml(msg)}`, true);
    progress(30 + (i / list.length) * 60, msg.toLowerCase().replace(/\.$/, ''));
    if (!skipped) await sleep(60 + Math.random() * 140);
  }

  // Phase 3 — wait for real work (prefs, registry, desktop)
  if (!workDone) {
    push('', `         Starting LTF Desktop Session...`);
    let p = 90;
    while (!workDone) {
      progress((p = Math.min(99, p + 1)), 'starting desktop session');
      await sleep(60);
    }
  }
  await workP.catch((err) => {
    console.error(err);
    push('', `${tag('fail')} Failed to start LTF Desktop Session: ${escapeHtml(err.message)}`, true);
  });

  push('arch', BANNER);
  push('', '');
  push('', 'ltf-os login: <b>ninja</b> (automatic login)', true);
  progress(100, 'welcome, ninja');
  window.removeEventListener('keydown', skip);
  await sleep(skipped ? 150 : 650);

  // Crossfade into the desktop
  boot.classList.add('fade-out');
  document.body.classList.remove('booting');
  await sleep(900);
  boot.remove();
}
