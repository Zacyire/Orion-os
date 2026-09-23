// System-wide runtime state that is per-device (not synced to the server):
// master volume used by every media app.

import { bus } from './events.js';
import { local } from './dom.js';

export const system = {
  volume: local.get('volume', 80),
  muted: local.get('muted', false),

  /** Effective output gain 0..1 used by media apps. */
  get gain() {
    return this.muted ? 0 : this.volume / 100;
  },

  setVolume(v) {
    this.volume = Math.round(v);
    if (this.volume > 0) this.muted = false;
    local.set('volume', this.volume);
    local.set('muted', this.muted);
    bus.emit('system:volume', this);
  },

  toggleMute() {
    this.muted = !this.muted;
    local.set('muted', this.muted);
    bus.emit('system:volume', this);
  },
};
