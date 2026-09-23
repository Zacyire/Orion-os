// Global event bus used for cross-module communication.
class Bus {
  #handlers = new Map();

  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this.#handlers.get(type)?.delete(fn);
  }

  emit(type, payload) {
    for (const fn of this.#handlers.get(type) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] handler for "${type}" failed`, err);
      }
    }
  }
}

export const bus = new Bus();
