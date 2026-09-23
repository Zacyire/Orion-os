// System-wide runtime state that isn't persisted on the server:
// master volume, quick-settings toggles, network status.

import { bus } from './events.js';
import { local } from './dom.js';

export const system = {
  volume: local.get('volume', 70),
  muted: local.get('muted', false),
  toggles: local.get('toggles', { wifi: true, bluetooth: true, airplane: false, saver: false, focus: false, night: false }),

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

  setToggle(key, value) {
    this.toggles[key] = value;
    if (key === 'airplane' && value) this.toggles.wifi = this.toggles.bluetooth = false;
    local.set('toggles', this.toggles);
    bus.emit('system:toggles', this.toggles);
  },
};
