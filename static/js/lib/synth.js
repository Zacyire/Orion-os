// Procedural synthwave engine (WebAudio). Generates a full arrangement from
// a small track "sheet" (bpm, root note, scale, waveform) so the Music app
// ships without any audio files. Exposes an AnalyserNode for visualizers.

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  pentatonic: [0, 3, 5, 7, 10, 12, 15],
};
const PROGRESSIONS = [[0, 5, 2, 6], [0, 3, 4, 3], [0, 6, 5, 4], [0, 4, 5, 3]];
export const BARS = 48;

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

function rng(seed) {
  let s = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export class SynthEngine {
  constructor() {
    this.ctx = null;
    this.track = null;
    this.step = 0;
    this.playing = false;
    this.volume = 0.8;
    this.onEnd = null;
  }

  _ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.comp = this.ctx.createDynamicsCompressor();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;
    // simple feedback delay for that 80s space
    this.delay = this.ctx.createDelay(1);
    this.fb = this.ctx.createGain();
    this.fb.gain.value = 0.28;
    this.delay.connect(this.fb).connect(this.delay);
    this.delay.connect(this.comp);
    this.master.connect(this.comp).connect(this.analyser).connect(this.ctx.destination);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.setVolume(this.volume);
  }

  get stepDur() {
    return 60 / this.track.bpm / 4; // 16th notes
  }

  get totalSteps() {
    return BARS * 16;
  }

  get duration() {
    return this.track ? this.totalSteps * this.stepDur : 0;
  }

  get position() {
    return this.track ? Math.min(this.duration, this.step * this.stepDur) : 0;
  }

  load(track) {
    this._ensure();
    this.track = track;
    const r = rng(track.id + track.title);
    const scale = SCALES[track.scale] || SCALES.minor;
    this.scale = scale;
    this.prog = PROGRESSIONS[Math.floor(r() * PROGRESSIONS.length)];
    // 2-bar lead motif (16th grid, -1 = rest)
    this.motif = Array.from({ length: 32 }, (_, i) => (i % 2 === 0 && r() < 0.55 ? Math.floor(r() * 7) : -1));
    this.arpShape = [0, 2, 4, 7].map((x) => x + (r() < 0.3 ? 1 : 0));
    this.dsp4 = track.bpm >= 120;
    this.delay.delayTime.value = this.stepDur * 3;
    this.seek(0);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v * 0.55, this.ctx.currentTime, 0.02);
  }

  async play() {
    if (!this.track) return;
    this._ensure();
    await this.ctx.resume();
    if (this.playing) return;
    this.playing = true;
    this.nextTime = this.ctx.currentTime + 0.05;
    this.timer = setInterval(() => this._schedule(), 25);
  }

  pause() {
    this.playing = false;
    clearInterval(this.timer);
  }

  seek(seconds) {
    if (!this.track) return;
    this.step = Math.max(0, Math.min(this.totalSteps - 1, Math.floor(seconds / this.stepDur)));
    if (this.ctx) this.nextTime = this.ctx.currentTime + 0.05;
  }

  destroy() {
    this.pause();
    this.ctx?.close();
  }

  _schedule() {
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      if (this.step >= this.totalSteps) {
        this.pause();
        this.onEnd?.();
        return;
      }
      this._playStep(this.step, this.nextTime);
      this.step++;
      this.nextTime += this.stepDur;
    }
  }

  _note(degree, octave) {
    const s = this.scale;
    const idx = ((degree % s.length) + s.length) % s.length;
    const oct = Math.floor(degree / s.length);
    return this.track.root + s[idx] + 12 * (octave + oct);
  }

  _playStep(step, t) {
    const bar = Math.floor(step / 16);
    const s16 = step % 16;
    const chordDeg = this.prog[Math.floor(bar / 2) % 4];
    const section = bar < 8 ? 'intro' : bar < 24 ? 'verse' : bar < 32 ? 'break' : bar < 46 ? 'chorus' : 'outro';
    const drums = section === 'verse' || section === 'chorus';

    // Pad: chord on each bar
    if (s16 === 0 && section !== 'outro') {
      for (const off of [0, 2, 4]) this._tone(midiHz(this._note(chordDeg + off, 1)), t, this.stepDur * 16, 'sawtooth', 0.045, 1800, 0.4);
    }
    // Bass: eighths
    if (section !== 'intro' && s16 % 2 === 0) {
      const oct = s16 % 4 === 2 ? 0 : -1;
      this._tone(midiHz(this._note(chordDeg, oct)), t, this.stepDur * 1.6, 'square', 0.16, 600, 0.02);
    }
    // Arp: 16ths
    if (section !== 'intro' || bar >= 4) {
      const a = this.arpShape[s16 % 4];
      this._tone(midiHz(this._note(chordDeg + a, 2 + (s16 >= 8 ? 1 : 0))), t, this.stepDur * 0.9, this.track.wave, 0.05, 3200, 0.01, true);
    }
    // Lead motif in chorus
    if (section === 'chorus') {
      const m = this.motif[(bar % 2) * 16 + s16];
      if (m >= 0) this._tone(midiHz(this._note(chordDeg + m, 2)), t, this.stepDur * 2.5, 'triangle', 0.12, 5000, 0.02, true);
    }
    // Drums
    if (drums) {
      if (this.dsp4 ? s16 % 4 === 0 : s16 === 0 || s16 === 8 || s16 === 11) this._kick(t);
      if (s16 === 4 || s16 === 12) this._noise(t, 0.18, 1800, 0.22);
      if (s16 % 2 === 0) this._noise(t, 0.04, 8000, s16 % 4 === 2 ? 0.08 : 0.05);
    } else if (section === 'break' && s16 % 4 === 0) {
      this._noise(t, 0.03, 9000, 0.04);
    }
  }

  _tone(freq, t, dur, type, gain, cutoff, attack = 0.01, echo = false) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    const f = c.createBiquadFilter();
    o.type = type;
    o.frequency.value = freq;
    if (type === 'sawtooth') o.detune.value = (Math.random() - 0.5) * 12;
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.master);
    if (echo) g.connect(this.delay);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  _kick(t) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.32);
  }

  _noise(t, dur, freq, gain) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = freq > 5000 ? 'highpass' : 'bandpass';
    f.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }
}

/** Procedural album art as a data URL. */
const artCache = new Map();
export function albumArt(track, size = 320) {
  const key = `${track.id}:${size}`;
  if (artCache.has(key)) return artCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const [a, b, d] = track.colors;
  const g = x.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, a);
  g.addColorStop(0.6, b);
  g.addColorStop(1, d);
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  const r = rng(track.id);
  x.globalCompositeOperation = 'overlay';
  for (let i = 0; i < 7; i++) {
    x.fillStyle = `rgba(255,255,255,${0.08 + r() * 0.2})`;
    x.beginPath();
    x.arc(r() * size, r() * size, size * (0.1 + r() * 0.4), 0, Math.PI * 2);
    x.fill();
  }
  x.globalCompositeOperation = 'source-over';
  x.strokeStyle = 'rgba(255,255,255,.35)';
  x.lineWidth = size / 160;
  for (let i = 0; i < 10; i++) {
    const y = size * 0.62 + i * i * (size / 260);
    x.beginPath();
    x.moveTo(0, y);
    x.lineTo(size, y);
    x.stroke();
  }
  x.fillStyle = '#fff';
  x.shadowColor = 'rgba(0,0,0,.4)';
  x.shadowBlur = size / 40;
  x.font = `800 ${size / 9}px system-ui, sans-serif`;
  x.fillText(track.title.toUpperCase(), size * 0.07, size * 0.2, size * 0.86);
  x.font = `500 ${size / 18}px system-ui, sans-serif`;
  x.fillText(track.artist, size * 0.07, size * 0.29, size * 0.86);
  const url = c.toDataURL('image/jpeg', 0.85);
  artCache.set(key, url);
  return url;
}
