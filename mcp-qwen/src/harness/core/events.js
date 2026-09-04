/**
 * Cordis-style Event Bus with Reversible Disposers
 * Provides lifecycle event decoupling where listeners return cleanup disposers.
 */

export class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  /**
   * Registers a listener for an event. Returns a disposer function that unbinds it cleanly.
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} Disposer
   */
  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    const handlers = this._listeners.get(event);
    handlers.add(handler);

    // Reversible effect disposer
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this._listeners.delete(event);
      }
    };
  }

  /**
   * Registers a one-shot listener.
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} Disposer
   */
  once(event, handler) {
    const dispose = this.on(event, (...args) => {
      dispose();
      handler(...args);
    });
    return dispose;
  }

  /**
   * Emits an event synchronously or asynchronously.
   * @param {string} event
   * @param  {...any} args
   * @returns {Promise<any[]>}
   */
  async emit(event, ...args) {
    const handlers = this._listeners.get(event);
    if (!handlers || handlers.size === 0) return [];
    const results = [];
    for (const h of Array.from(handlers)) {
      try {
        const res = h(...args);
        results.push(res instanceof Promise ? await res : res);
      } catch (err) {
        console.error(`[EventBus] Error in handler for event '${event}':`, err);
        results.push({ error: err, isError: true });
      }
    }
    return results;
  }

  /**
   * Clears all listeners.
   */
  clear() {
    this._listeners.clear();
  }
}
