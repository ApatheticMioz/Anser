/**
 * Cordis-Style Microkernel Core
 *
 * Implements "Everything is a Plugin" with reversible effects:
 * - Service container with dependency injection
 * - Pluggable tool registry
 * - Reversible disposers that unbind listeners and registrations on unmount
 * - Context hierarchy supporting isolated child contexts
 */

import { EventBus } from "./events.js";

export class Context {
  /**
   * @param {Context|null} parent
   * @param {string} [name="root"]
   */
  constructor(parent = null, name = "root") {
    this.name = name;
    this.parent = parent;
    this.root = parent ? (parent.root || parent) : this;
    this.events = parent ? parent.events : new EventBus();
    this.services = parent ? new Map(parent.services) : new Map();
    this.tools = parent ? new Map(parent.tools) : new Map();
    this._disposers = new Set();
    this._plugins = new Map();
  }

  /**
   * Registers a reusable service in the container.
   * @param {string} name
   * @param {any} service
   * @returns {() => void} Disposer
   */
  provide(name, service) {
    const target = this.root || this;
    target.services.set(name, service);
    target[name] = service;
    this.services.set(name, service);
    this[name] = service;

    const dispose = () => {
      if (this.services.get(name) === service) {
        this.services.delete(name);
        delete this[name];
      }
      if (target.services.get(name) === service) {
        target.services.delete(name);
        delete target[name];
      }
    };
    this._disposers.add(dispose);
    return dispose;
  }

  /**
   * Retrieves a registered service.
   * @param {string} name
   */
  get(name) {
    if (this.services.has(name)) return this.services.get(name);
    if (this.root && this.root.services.has(name)) return this.root.services.get(name);
    return undefined;
  }

  /**
   * Registers a tool available to the agent.
   * @param {string} name
   * @param {object} definition { description, parameters, execute }
   * @returns {() => void} Disposer
   */
  registerTool(name, definition) {
    if (!definition || typeof definition.execute !== "function") {
      throw new Error(`Tool '${name}' must provide an execute(params, ctx) function`);
    }
    const target = this.root || this;
    const toolEntry = {
      name,
      description: definition.description || "",
      parameters: definition.parameters || {},
      execute: definition.execute,
    };
    target.tools.set(name, toolEntry);
    this.tools.set(name, toolEntry);

    const dispose = () => {
      this.tools.delete(name);
      if (target.tools.get(name) === toolEntry) {
        target.tools.delete(name);
      }
    };
    this._disposers.add(dispose);
    this.events.emit("tool:registered", toolEntry);
    return dispose;
  }

  /**
   * Lists all available tools formatted for model consumption (OpenAI / MCP schema).
   */
  listTools() {
    const toolsMap = this.root ? this.root.tools : this.tools;
    return Array.from(toolsMap.values()).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * Executes a registered tool by name with safety wrapping.
   * @param {string} name
   * @param {object} args
   */
  async executeTool(name, args = {}) {
    const toolsMap = this.root ? this.root.tools : this.tools;
    const tool = toolsMap.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' is not registered in the harness kernel`);
    }
    await this.events.emit("tool:before_execute", { name, args });
    const t0 = Date.now();
    try {
      const result = await tool.execute(args, this);
      const dt = Date.now() - t0;
      await this.events.emit("tool:after_execute", { name, args, result, latencyMs: dt, isError: false });
      return { isError: false, result, latencyMs: dt };
    } catch (err) {
      const dt = Date.now() - t0;
      await this.events.emit("tool:after_execute", { name, args, error: err.message, latencyMs: dt, isError: true });
      return { isError: true, error: err.message, latencyMs: dt };
    }
  }

  /**
   * Mounts a plugin into the context.
   * @param {Function|object} plugin Plugin function (ctx, options) or { apply: (ctx, options) }
   * @param {object} [options={}]
   * @returns {() => void} Disposer to cleanly unmount the plugin and all its effects
   */
  plugin(plugin, options = {}) {
    const childCtx = new Context(this, plugin.name || "plugin");
    let resultDisposer = null;

    if (typeof plugin === "function") {
      resultDisposer = plugin(childCtx, options);
    } else if (plugin && typeof plugin.apply === "function") {
      resultDisposer = plugin.apply(childCtx, options);
    } else {
      throw new Error("Plugin must be a callable function or object with an apply() method");
    }

    const unmount = () => {
      if (typeof resultDisposer === "function") {
        try {
          resultDisposer();
        } catch {}
      }
      childCtx.dispose();
      this._plugins.delete(plugin);
    };

    this._plugins.set(plugin, unmount);
    this._disposers.add(unmount);
    return unmount;
  }

  /**
   * Disposes of the context and cleanly unwinds all registrations and listeners.
   */
  dispose() {
    for (const d of Array.from(this._disposers)) {
      try {
        d();
      } catch {}
    }
    this._disposers.clear();
    this.services.clear();
    this.tools.clear();
    this._plugins.clear();
  }
}
