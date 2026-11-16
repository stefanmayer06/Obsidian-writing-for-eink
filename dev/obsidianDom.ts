/**
 * The few DOM helpers of Obsidian that the ink engine uses (createEl,
 * createDiv, createSpan on nodes and as globals), for running it outside
 * Obsidian in the dev harness. Import it before the engine.
 */
type Info = { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean | null>; parent?: Node; prepend?: boolean };

function make<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, o?: Info | string): HTMLElementTagNameMap[K] {
  const info: Info = typeof o === "string" ? { cls: o } : (o ?? {});
  const el = doc.createElement(tag);
  if (info.cls) el.className = Array.isArray(info.cls) ? info.cls.join(" ") : info.cls;
  if (info.text !== undefined) el.textContent = info.text;
  for (const [k, v] of Object.entries(info.attr ?? {})) if (v !== null && v !== false) el.setAttribute(k, v === true ? "" : String(v));
  if (info.parent) {
    if (info.prepend) info.parent.insertBefore(el, info.parent.firstChild);
    else info.parent.appendChild(el);
  }
  return el;
}

const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.createEl !== "function") {
  g.createEl = (tag: keyof HTMLElementTagNameMap, o?: Info | string) => make(document, tag, o);
  g.createDiv = (o?: Info | string) => make(document, "div", o);
  g.createSpan = (o?: Info | string) => make(document, "span", o);
  const withParent = (node: Node, o?: Info | string): Info => ({ ...(typeof o === "string" ? { cls: o } : o), parent: node });
  const docOf = (node: Node) => node.ownerDocument ?? (node as Document);
  Object.assign(Node.prototype, {
    createEl(this: Node, tag: keyof HTMLElementTagNameMap, o?: Info | string) {
      return make(docOf(this), tag, withParent(this, o));
    },
    createDiv(this: Node, o?: Info | string) {
      return make(docOf(this), "div", withParent(this, o));
    },
    createSpan(this: Node, o?: Info | string) {
      return make(docOf(this), "span", withParent(this, o));
    },
  });
  Object.assign(HTMLElement.prototype, {
    isShown(this: HTMLElement) {
      return this.getClientRects().length > 0;
    },
  });
}
