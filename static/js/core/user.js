// User profile helpers (display name lives in prefs.user).
import { h } from './dom.js';
import { store } from './store.js';

export function initials(name = store.get('user.name') || 'User') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || 'U') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

/** Round avatar with the user's initials (accent gradient). */
export function avatar(size = '') {
  return h(`span.avatar${size ? `.${size}` : ''}`, { 'aria-hidden': 'true' }, initials());
}
