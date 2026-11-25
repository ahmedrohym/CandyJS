/*!
 * CandyJS - a tiny, dependency-free UI library built on Web Components.
 *
 *   class Counter extends Candy {
 *     state = { count: 0 };
 *     static template = `
 *       <button onclick="{this.state.count++}">+</button> {this.state.count}`;
 *   }
 *   Counter.register();              // -> <counter-js></counter-js>
 */
(function (global) {
  'use strict';

  const RAW = Symbol('candy.raw');
  const EMPTY = Object.freeze(Object.create(null));
  const compiled = new WeakSet();   // nodes already processed
  const attrsCompiled = new WeakSet();
  const fnCache = new Map();
  const propCache = new Map();
  const instances = new Set();

  /* ------------------------------------------------------------------ *
   * Template parsing: "Hello {name}!" -> ['Hello ', {expr:'name'}, '!']
   * Handles nested braces and braces inside string literals.
   * ------------------------------------------------------------------ */
  function skipString(str, i) {
    const quote = str[i];
    for (i++; i < str.length; i++) {
      if (str[i] === '\\') { i++; continue; }
      if (str[i] === quote) return i;
    }
    return -1;
  }

  function findClose(str, start) {
    let depth = 0;
    for (let i = start; i < str.length; i++) {
      const ch = str[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        i = skipString(str, i);
        if (i === -1) return -1;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function parseTemplate(str) {
    if (!str || str.indexOf('{') === -1) return null;
    const parts = [];
    let buf = '';
    let hasExpr = false;
    let i = 0;
    while (i < str.length) {
      const ch = str[i];
      if (ch === '\\' && str[i + 1] === '{') { buf += '{'; i += 2; continue; }
      if (ch === '{') {
        const end = findClose(str, i);
        if (end === -1) { buf += str.slice(i); break; }
        const expr = str.slice(i + 1, end).trim();
        if (expr) {
          if (buf) parts.push(buf);
          buf = '';
          parts.push({ expr });
          hasExpr = true;
        } else {
          buf += '{}';
        }
        i = end + 1;
        continue;
      }
      buf += ch;
      i++;
    }
    if (buf) parts.push(buf);
    return hasExpr ? parts : null;
  }

  /** Accepts `"{expr}"` or a bare `"expr"` (used by directives). */
  function exprOf(value) {
    const parts = parseTemplate(value);
    if (parts && parts.length === 1 && typeof parts[0] !== 'string') return parts[0].expr;
    return value;
  }

  /* ------------------------------------------------------------------ *
   * Expression evaluation
   * `this` is the owning component; bare identifiers resolve to local
   * variables (loop items, `event`), then to refs, then to globals.
   * ------------------------------------------------------------------ */
  function compileFn(code, isBody) {
    const key = (isBody ? 'B:' : 'E:') + code;
    let fn = fnCache.get(key);
    if (!fn) {
      const body = isBody ? code : 'return (' + code + '\n);';
      // Function bodies are sloppy-mode unless they opt in, so `with` is allowed.
      fn = new Function('$scope', 'with ($scope) {\n' + body + '\n}');
      fnCache.set(key, fn);
    }
    return fn;
  }

  function makeScope(locals, ctx) {
    return new Proxy(locals, {
      has(target, key) {
        if (typeof key !== 'string') return false;
        if (key in target) return true;
        return !!ctx && ctx.$ref(key) !== undefined;
      },
      get(target, key) {
        if (key === Symbol.unscopables) return undefined;
        if (key in target) return target[key];
        return ctx ? ctx.$ref(key) : undefined;
      },
      set(target, key, value) {
        let owner = target;
        while (owner && !Object.prototype.hasOwnProperty.call(owner, key)) owner = Object.getPrototypeOf(owner);
        if (!owner || Object.isFrozen(owner)) return false;
        owner[key] = value;
        return true;
      },
    });
  }

  function run(code, ctx, locals, isBody) {
    try {
      return compileFn(code, isBody).call(ctx, makeScope(locals || EMPTY, ctx));
    } catch (err) {
      console.error('[Candy] error in {' + code + '}', err);
      return undefined;
    }
  }

  function interpolate(parts, ctx, locals) {
    let out = '';
    for (const p of parts) {
      if (typeof p === 'string') { out += p; continue; }
      const v = run(p.expr, ctx, locals);
      out += v == null ? '' : String(v);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Reactivity: deep proxies that call `notify` on any mutation.
   * ------------------------------------------------------------------ */
  function isPlain(v) {
    if (v === null || typeof v !== 'object') return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === Array.prototype || proto === null;
  }

  function reactive(obj, notify, cache) {
    if (!isPlain(obj) || obj[RAW]) return obj;
    cache = cache || new WeakMap();
    let proxy = cache.get(obj);
    if (proxy) return proxy;
    proxy = new Proxy(obj, {
      get(target, key, receiver) {
        if (key === RAW) return target;
        const v = Reflect.get(target, key, receiver);
        return isPlain(v) ? reactive(v, notify, cache) : v;
      },
      set(target, key, value) {
        const old = target[key];
        const raw = value && value[RAW] ? value[RAW] : value;
        target[key] = raw;
        if (old !== raw || key === 'length') notify();
        return true;
      },
      deleteProperty(target, key) {
        const had = Object.prototype.hasOwnProperty.call(target, key);
        delete target[key];
        if (had) notify();
        return true;
      },
    });
    cache.set(obj, proxy);
    return proxy;
  }

  /* ------------------------------------------------------------------ *
   * Bindings
   * ------------------------------------------------------------------ */
  function addBinding(binding, ctx, collector) {
    ctx._bindings.push(binding);
    for (let c = collector; c; c = c.parent) c.push(binding);
    return binding;
  }

  function newCollector(parent) {
    const c = [];
    c.parent = parent || null;
    return c;
  }

  function dispose(collector) {
    for (const b of collector) b.dead = true;
    collector.length = 0;
  }

  function findProp(el, name) {
    if (name in el) return name;
    const key = el.constructor.name + '|' + name;
    if (propCache.has(key) && !(el instanceof Candy)) return propCache.get(key);
    let found = null;
    for (let o = el; o && !found; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) {
        if (k.toLowerCase() === name) { found = k; break; }
      }
    }
    if (!(el instanceof Candy)) propCache.set(key, found);
    return found;
  }

  const ATTR_ONLY = /^(class|style|data-.*|aria-.*|role|slot|is)$/;

  function bindEvent(el, name, parts, ctx, locals) {
    const expr = parts.find((p) => typeof p !== 'string').expr;
    const handler = function (...args) {
      const l = Object.create(locals);
      l.event = args[0];
      l.args = args;
      const result = run(expr, ctx, l);
      return typeof result === 'function' ? result.apply(ctx, args) : result;
    };
    // Removing an on* content attribute resets the handler, so remove first.
    el.removeAttribute(name);
    const prop = findProp(el, name);
    if (prop) el[prop] = handler;
    else el.addEventListener(name.slice(2), handler);
  }

  function attrBinding(el, name, parts, ctx, locals) {
    const single = parts.length === 1 && typeof parts[0] !== 'string';
    let prop = ATTR_ONLY.test(name) ? null : findProp(el, name);
    if (!prop && el instanceof Candy && !ATTR_ONLY.test(name)) prop = name;
    if (prop) el.removeAttribute(name);
    return {
      node: el,
      refresh() {
        const value = single ? run(parts[0].expr, ctx, locals) : interpolate(parts, ctx, locals);
        if (prop) {
          if (el[prop] !== value) el[prop] = value;
        } else if (value === false || value == null) {
          el.removeAttribute(name);
        } else {
          const str = value === true ? '' : String(value);
          if (el.getAttribute(name) !== str) el.setAttribute(name, str);
        }
      },
    };
  }

  function textBinding(node, parts, ctx, locals) {
    return {
      node,
      refresh() {
        const value = interpolate(parts, ctx, locals);
        if (node.nodeValue !== value) node.nodeValue = value;
      },
    };
  }

  function isCandyScript(el) {
    return el.type === 'text/candy' || el.hasAttribute('candy');
  }

  function htmlBinding(script, ctx, locals, collector) {
    const container = document.createElement('span');
    container.style.display = 'contents';
    const code = script.textContent;
    const isBody = script.hasAttribute('function');
    script.replaceWith(container);
    let last = null;
    let block = null;
    return {
      node: container,
      refresh() {
        const v = run(code, ctx, locals, isBody);
        const html = Array.isArray(v) ? v.join('') : v == null ? '' : String(v);
        if (html === last) return;
        last = html;
        if (block) dispose(block);
        block = newCollector(collector);
        container.innerHTML = html;
        compileChildren(container, ctx, locals, block);
      },
    };
  }

  function renderBlock(tpl, anchor, ctx, locals, collector) {
    const frag = tpl.content.cloneNode(true);
    const nodes = Array.from(frag.childNodes);
    const bindings = newCollector(collector);
    anchor.parentNode.insertBefore(frag, anchor);
    for (const n of nodes) compileNode(n, ctx, locals, bindings);
    return { nodes, bindings, locals };
  }

  function removeBlock(block) {
    for (const n of block.nodes) n.remove();
    dispose(block.bindings);
  }

  function eachBinding(tpl, ctx, locals, collector) {
    const expr = exprOf(tpl.getAttribute('each'));
    const as = tpl.getAttribute('as') || 'item';
    const indexName = tpl.getAttribute('index') || 'index';
    const anchor = document.createComment('each');
    tpl.replaceWith(anchor);
    const blocks = [];
    return {
      node: anchor,
      refresh() {
        let list = run(expr, ctx, locals);
        if (typeof list === 'number') list = Array.from({ length: list }, (_, i) => i);
        else if (list == null) list = [];
        else if (!Array.isArray(list)) list = Array.from(list);
        while (blocks.length > list.length) removeBlock(blocks.pop());
        for (let i = 0; i < list.length; i++) {
          if (blocks[i]) {
            blocks[i].locals[as] = list[i];
            blocks[i].locals[indexName] = i;
          } else {
            const l = Object.create(locals);
            l[as] = list[i];
            l[indexName] = i;
            blocks.push(renderBlock(tpl, anchor, ctx, l, collector));
          }
        }
      },
    };
  }

  function ifBinding(tpl, ctx, locals, collector) {
    const expr = exprOf(tpl.getAttribute('if'));
    let elseTpl = tpl.nextElementSibling;
    if (!(elseTpl && elseTpl.tagName === 'TEMPLATE' && elseTpl.hasAttribute('else'))) elseTpl = null;
    const anchor = document.createComment('if');
    tpl.replaceWith(anchor);
    if (elseTpl) elseTpl.remove();
    let state = null;
    let block = null;
    return {
      node: anchor,
      refresh() {
        const next = !!run(expr, ctx, locals);
        if (next === state) return;
        state = next;
        if (block) removeBlock(block);
        block = null;
        const chosen = next ? tpl : elseTpl;
        if (chosen) block = renderBlock(chosen, anchor, ctx, locals, collector);
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * Compiler: walks a component's own subtree. Nested components get
   * their attributes compiled by the parent and compile their children
   * themselves.
   * ------------------------------------------------------------------ */
  function registerRef(ctx, name, el) {
    ctx.refs[name] = el;
    for (let p = ctx.$parent; p; p = p.$parent) {
      if (!(name in p.refs)) p.refs[name] = el;
    }
  }

  function compileAttributes(el, ctx, locals, collector) {
    if (attrsCompiled.has(el)) return;
    attrsCompiled.add(el);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      if (name === 'ref') { registerRef(ctx, attr.value, el); continue; }
      const parts = parseTemplate(attr.value);
      if (!parts) continue;
      if (name.startsWith('on')) bindEvent(el, name, parts, ctx, locals);
      else addBinding(attrBinding(el, name, parts, ctx, locals), ctx, collector);
    }
  }

  function compileNode(node, ctx, locals, collector) {
    if (compiled.has(node)) return;
    compiled.add(node);

    if (node.nodeType === Node.TEXT_NODE) {
      const parts = parseTemplate(node.nodeValue);
      if (parts) addBinding(textBinding(node, parts, ctx, locals), ctx, collector);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName;
    if (tag === 'SCRIPT') {
      if (isCandyScript(node)) addBinding(htmlBinding(node, ctx, locals, collector), ctx, collector);
      return;
    }
    if (tag === 'STYLE' || node.hasAttribute('candy-ignore')) return;
    if (tag === 'TEMPLATE') {
      if (node.hasAttribute('each')) addBinding(eachBinding(node, ctx, locals, collector), ctx, collector);
      else if (node.hasAttribute('if')) addBinding(ifBinding(node, ctx, locals, collector), ctx, collector);
      return;
    }

    compileAttributes(node, ctx, locals, collector);
    if (node instanceof Candy) {
      if (locals !== EMPTY) node.__candyLocals = locals;
      return;
    }
    compileChildren(node, ctx, locals, collector);
  }

  function compileChildren(root, ctx, locals, collector) {
    for (const child of Array.from(root.childNodes)) compileNode(child, ctx, locals, collector);
  }

  /* ------------------------------------------------------------------ *
   * Mount queue: components initialise once the DOM below them exists,
   * parents before children.
   * ------------------------------------------------------------------ */
  const pending = new Set();
  let flushScheduled = false;

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', flush, { once: true });
    else queueMicrotask(flush);
  }

  function flush() {
    flushScheduled = false;
    const list = Array.from(pending).filter((c) => c.isConnected && !c._ready);
    pending.clear();
    list.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    for (const c of list) if (!c._ready) c._init();
  }

  function hasContent(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === Node.ELEMENT_NODE) return true;
      if (n.nodeType === Node.TEXT_NODE && n.nodeValue.trim()) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Base component
   * ------------------------------------------------------------------ */
  class Candy extends HTMLElement {
    constructor() {
      super();
      this.refs = Object.create(null);
      this._bindings = [];
      this._ready = false;
      this._updateQueued = false;
      // Auto-bind methods so they can be passed around as callbacks.
      for (let proto = Object.getPrototypeOf(this); proto && proto !== Candy.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const key of Object.getOwnPropertyNames(proto)) {
          if (key === 'constructor' || Object.prototype.hasOwnProperty.call(this, key)) continue;
          const d = Object.getOwnPropertyDescriptor(proto, key);
          if (typeof d.value === 'function') this[key] = d.value.bind(this);
        }
      }
    }

    static register(tag) {
      tag = tag || this.tag || this.name.toLowerCase() + '-js';
      if (!customElements.get(tag)) customElements.define(tag, this);
      return this;
    }

    connectedCallback() {
      if (this._ready) instances.add(this);
      else { pending.add(this); scheduleFlush(); }
    }

    disconnectedCallback() {
      instances.delete(this);
    }

    /** Nearest Candy ancestor element. */
    get $parent() {
      for (let n = this.parentNode; n; n = n.parentNode || n.host) {
        if (n instanceof Candy) return n;
      }
      return null;
    }

    /** Looks a `ref` up here, then in ancestors. */
    $ref(name) {
      for (let c = this; c; c = c.$parent) {
        if (name in c.refs) return c.refs[name];
      }
      return undefined;
    }

    _init() {
      this._ready = true;
      instances.add(this);

      if (Object.prototype.hasOwnProperty.call(this, 'state')) {
        const cache = new WeakMap();
        const notify = () => this.scheduleUpdate();
        let state = reactive(this.state, notify, cache);
        Object.defineProperty(this, 'state', {
          configurable: true,
          enumerable: true,
          get: () => state,
          set: (v) => { state = reactive(v, notify, cache); notify(); },
        });
      }

      const tpl = this.constructor.template;
      if (tpl != null && !hasContent(this)) {
        this.innerHTML = typeof tpl === 'function' ? tpl.call(this) : String(tpl);
      }

      const locals = this.__candyLocals || EMPTY;
      if (!this.$parent) compileAttributes(this, this, locals, null);
      compileChildren(this, this, locals, null);
      this.update();
      this.onMount();
    }

    _render() {
      this.onUpdate();
      const list = this._bindings;
      let dead = false;
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b.dead) { dead = true; continue; }
        if (b.node.isConnected) b.refresh();
      }
      if (dead) this._bindings = list.filter((b) => !b.dead);
    }

    /** Re-renders this component and every component inside it. */
    update() {
      if (!this._ready) return;
      this._updateQueued = false;
      this._render();
      for (const c of Array.from(instances)) {
        if (c !== this && c._ready && this.contains(c)) c._render();
      }
    }

    /** Batches several changes into one update (used by `state`). */
    scheduleUpdate() {
      if (this._updateQueued) return;
      this._updateQueued = true;
      queueMicrotask(() => { if (this._updateQueued) this.update(); });
    }

    /** Dispatches a bubbling CustomEvent; listen with on<name>="{...}". */
    emit(name, detail) {
      return this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
    }

    /** Called once, after the first render. */
    onMount() {}

    /** Called before every render. */
    onUpdate() {}
  }

  Candy.reactive = (obj, notify) => reactive(obj, notify || (() => {}));
  Candy.parseTemplate = parseTemplate;
  Candy.version = '0.2.0';
  Candy.register();   // <candy-js> works as a plain root/container component

  global.Candy = Candy;
})(typeof window !== 'undefined' ? window : globalThis);
