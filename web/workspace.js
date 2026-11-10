// Geekatplay Canvas workspace. Framework-free: the ComfyUI glue lives in gap_canvas.js.

export const RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9", "9:21", "5:4", "4:5", "2:1", "1:2"];
export const SIZES = [0.5, 1, 1.5, 2, 4];
const COLORS = ["#111111", "#ffffff", "#e5484d", "#f76b15", "#ffc53d", "#46a758", "#3e63dd", "#8e4ec6"];
const NOTE_COLOR = "#ffb224";
const ACCENT = "#6ea8fe";
const FONT = 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif';
const HISTORY = 60;

const ICONS = {
  select: "M5 3l14 8-6 2-2 6z",
  pen: "M4 20l1-4L16 5l3 3L8 19zM14 7l3 3",
  eraser: "M20 20H9l-5-5a2 2 0 010-3l8-8a2 2 0 013 0l5 5a2 2 0 010 3l-7 8M7 11l6 6",
  note: "M5 4h14v11l-5 5H5zM14 20v-5h5M8 9h8M8 13h4",
  hand: "M8 11V5a1.5 1.5 0 013 0v5V4a1.5 1.5 0 013 0v6V6a1.5 1.5 0 013 0v8a7 7 0 01-7 7c-3 0-4-1-6-4l-2-4a1.5 1.5 0 012.5-1.5L8 14",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5a1 1 0 100-.01",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  max: "M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5M4 4l6 6M20 4l-6 6M4 20l6-6M20 20l-6-6",
  prompt: "M4 5h16v11H9l-5 4zM8 9h8M8 12h5",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  close: "M6 6l12 12M18 6L6 18",
};

const HINTS = {
  select: "Drag to move, corners resize (Shift = free), top handle rotates. Right-click for notes and options. Click the canvas, then wheel zooms and Space-drag pans.",
  pen: "Draw on the canvas. Strokes close to each other become one sketch you can move and annotate.",
  eraser: "Drag over strokes to erase them.",
  note: "Click anywhere - on an image, a sketch or empty space - to pin an instruction there.",
  hand: "Drag to pan, wheel to zoom.",
};

function el(tag, cls, props) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (props) Object.assign(node, props);
  return node;
}

function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function hash(text) {
  let a = 0x811c9dc5, b = 0x1b873593;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

function rotate(x, y, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [x * c - y * s, x * s + y * c];
}

export function frameSize(ratio, megapixels) {
  const [rw, rh] = ratio.split(":").map(Number);
  const scale = Math.sqrt(megapixels * 1048576 / (rw * rh));
  return { w: Math.round(rw * scale / 16) * 16, h: Math.round(rh * scale / 16) * 16 };
}

export function emptyScene(model) {
  return { v: 1, model: model || "qwen_edit", layout: "auto", frame: { ratio: "1:1", mp: 1, w: 1024, h: 1024 }, items: [] };
}

function aabb(item) {
  const c = Math.abs(Math.cos(item.rot || 0)), s = Math.abs(Math.sin(item.rot || 0));
  const hw = (item.w * c + item.h * s) / 2, hh = (item.w * s + item.h * c) / 2;
  return [item.cx - hw, item.cy - hh, item.cx + hw, item.cy + hh];
}

function toLocal(item, x, y) {
  return rotate(x - item.cx, y - item.cy, -(item.rot || 0));
}

function contains(item, x, y) {
  const [lx, ly] = toLocal(item, x, y);
  return Math.abs(lx) <= item.w / 2 && Math.abs(ly) <= item.h / 2;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// Sketch strokes live in the sketch's own base box (bw x bh); this re-fits the box after strokes change.
function refitSketch(item) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of item.strokes) {
    for (let i = 0; i < st.p.length; i += 2) {
      x0 = Math.min(x0, st.p[i] - st.s / 2); x1 = Math.max(x1, st.p[i] + st.s / 2);
      y0 = Math.min(y0, st.p[i + 1] - st.s / 2); y1 = Math.max(y1, st.p[i + 1] + st.s / 2);
    }
  }
  const kx = item.w / item.bw, ky = item.h / item.bh;
  const [ox, oy] = rotate(((x0 + x1) / 2 - item.bw / 2) * kx, ((y0 + y1) / 2 - item.bh / 2) * ky, item.rot || 0);
  for (const st of item.strokes) {
    for (let i = 0; i < st.p.length; i += 2) { st.p[i] -= x0; st.p[i + 1] -= y0; }
  }
  item.bw = Math.max(1, x1 - x0); item.bh = Math.max(1, y1 - y0);
  item.w = item.bw * kx; item.h = item.bh * ky;
  item.cx += ox; item.cy += oy;
}

function wrapText(ctx, text, width, maxLines) {
  const lines = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? line + " " + word : word;
      if (line && ctx.measureText(next).width > width) { lines.push(line); line = word; } else line = next;
    }
    lines.push(line);
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,3}$/, "...");
  }
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class Workspace {
  // opts: profiles, uploadImage(file) -> {name, subfolder, type}, uploadRender(blob, name) -> name,
  //       viewUrl(file) -> string, compile(scene) -> {prompt, slots, warnings}, onChange()
  constructor(host, opts) {
    this.host = host;
    this.opts = opts;
    this.scene = emptyScene(opts.defaultModel);
    this.view = { x: 0, y: 0, z: 1 };
    this.tool = "select";
    this.color = COLORS[0];
    this.size = 6;
    this.sel = new Set();
    this.images = new Map();
    this.pending = new Set();
    this.past = [];
    this.future = [];
    this.saved = JSON.stringify(this.scene);
    this.pointers = new Map();
    this.drag = null;
    this.renders = { key: "" };
    this.uploaded = new Set();
    this.compiled = { prompt: "", slots: [], warnings: [] };
    this.fitted = false;
    this.build();
    this.setTool("select");
    this.syncControls();
  }

  // ---------- DOM ----------

  build() {
    const root = this.root = el("div", "gapc-root", { tabIndex: 0 });
    root.setAttribute("role", "application");
    root.setAttribute("aria-label", "Geekatplay Canvas workspace");
    // ComfyUI leaves the wheel to an element marked like this once focus is inside it
    root.dataset.captureWheel = "true";
    const bar = el("div", "gapc-bar");
    const button = (name, title, onClick, text) => {
      const b = el("button", "gapc-btn", { type: "button", title, innerHTML: icon(name) + (text ? `<span>${text}</span>` : "") });
      b.setAttribute("aria-label", title);
      b.addEventListener("click", onClick);
      return b;
    };

    const tools = el("div", "gapc-group");
    this.toolButtons = {};
    for (const [name, title] of [["select", "Select and move (V)"], ["pen", "Draw (B)"], ["eraser", "Erase strokes (E)"], ["note", "Pin a note (N)"], ["hand", "Pan (H or hold Space)"]]) {
      tools.append(this.toolButtons[name] = button(name, title, () => this.setTool(name)));
    }

    const pen = el("div", "gapc-pen");
    this.swatches = COLORS.map((color) => {
      const s = el("button", "gapc-swatch", { type: "button", title: "Pen color " + color });
      s.style.background = color;
      s.addEventListener("click", () => this.setColor(color));
      pen.append(s);
      return s;
    });
    this.colorInput = el("input", "gapc-color", { type: "color", title: "Custom pen color", value: this.color });
    this.colorInput.addEventListener("input", () => this.setColor(this.colorInput.value));
    pen.append(this.colorInput);
    const penSize = el("div", "gapc-pen gapc-pen-size");
    this.sizeInput = el("input", "gapc-range", { type: "range", min: 1, max: 60, value: this.size, title: "Brush size ([ and ])" });
    this.sizeInput.addEventListener("input", () => { this.size = Number(this.sizeInput.value); });
    penSize.append(this.sizeInput);

    this.fileInput = el("input", "", { type: "file", accept: "image/*", multiple: true, hidden: true });
    this.fileInput.addEventListener("change", () => {
      this.addFiles([...this.fileInput.files]);
      this.fileInput.value = "";
    });
    const edit = el("div", "gapc-group");
    this.undoButton = button("undo", "Undo (Ctrl+Z)", () => this.undo());
    this.redoButton = button("redo", "Redo (Ctrl+Shift+Z)", () => this.redo());
    edit.append(button("image", "Add images (or drop / paste them)", () => this.fileInput.click(), "Add image"), this.undoButton, this.redoButton);

    const select = (title, onChange) => {
      const s = el("select", "gapc-select", { title });
      s.setAttribute("aria-label", title);
      s.addEventListener("change", onChange);
      return s;
    };
    this.modelSelect = select("Image model the prompt and references are prepared for", () => this.change(() => { this.scene.model = this.modelSelect.value; }));
    for (const [kind, label] of [["local", "Local models"], ["api", "Partner API"]]) {
      const group = el("optgroup", "", { label });
      for (const p of this.opts.profiles.filter((p) => p.kind === kind)) group.append(el("option", "", { value: p.key, textContent: p.label }));
      this.modelSelect.append(group);
    }
    this.ratioSelect = select("Aspect ratio of the picture", () => this.setFrame(this.ratioSelect.value, this.scene.frame.mp));
    for (const r of RATIOS) this.ratioSelect.append(el("option", "", { value: r, textContent: r }));
    this.ratioSelect.classList.add("gapc-short");
    this.customRatio = el("option", "", { value: "custom", textContent: "Custom", hidden: true });
    this.ratioSelect.append(this.customRatio);
    this.sizeSelect = select("Resolution in megapixels", () => this.setFrame(this.scene.frame.ratio, Number(this.sizeSelect.value)));
    this.sizeSelect.classList.add("gapc-short");
    for (const mp of SIZES) this.sizeSelect.append(el("option", "", { value: mp, textContent: mp + " MP" }));
    this.layoutSelect = select("Layout guide: send the arranged frame to the model as its first image", () => this.change(() => { this.scene.layout = this.layoutSelect.value; }));
    for (const [value, label] of [["auto", "Layout: auto"], ["on", "Layout: on"], ["off", "Layout: off"]]) this.layoutSelect.append(el("option", "", { value, textContent: label }));

    const viewGroup = el("div", "gapc-group");
    this.maxButton = button("max", "Maximize workspace (Esc to leave)", () => this.toggleMax());
    viewGroup.append(button("fit", "Fit everything in view (F)", () => this.fit()), this.maxButton);

    bar.append(tools, el("div", "gapc-sep"), pen, penSize, edit, el("div", "gapc-grow"), this.modelSelect, this.ratioSelect, this.sizeSelect, this.layoutSelect, viewGroup);

    const stage = this.stage = el("div", "gapc-stage");
    this.cv = el("canvas", "gapc-canvas");
    this.ctx = this.cv.getContext("2d");
    this.toast = el("div", "gapc-toast");
    this.toast.setAttribute("role", "status");
    this.panel = el("div", "gapc-panel");
    const head = el("header", "", { textContent: "Compiled prompt" });
    head.append(button("close", "Close", () => this.panel.classList.remove("gapc-open")));
    this.warnList = el("div", "gapc-warnlist");
    this.promptText = el("pre");
    this.panel.append(head, this.warnList, this.promptText);
    stage.append(this.cv, el("div", "gapc-drop", { textContent: "Drop images to add them as references" }), this.panel, this.toast);

    const status = el("div", "gapc-status");
    this.hint = el("div", "gapc-hint");
    this.chips = el("div", "gapc-chips");
    status.append(this.hint, this.chips, button("prompt", "Show the prompt compiled for the selected model", () => this.panel.classList.toggle("gapc-open"), "Prompt"));

    root.append(bar, stage, status, this.fileInput);
    this.host.append(root);
    this.bind();
    new ResizeObserver(() => this.resize()).observe(stage);
  }

  bind() {
    const root = this.root, cv = this.cv;
    // Nothing that happens inside the workspace should reach the graph editor around it.
    for (const type of ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keyup", "copy", "cut", "dragstart"]) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    root.addEventListener("pointerdown", (e) => {
      if (this.menu && !this.menu.contains(e.target)) { this.menu.remove(); this.menu = null; }
    }, true);
    root.addEventListener("keydown", (e) => this.onKey(e));
    root.addEventListener("paste", (e) => this.onPaste(e));
    cv.addEventListener("pointerdown", (e) => this.onDown(e));
    cv.addEventListener("pointermove", (e) => this.onMove(e));
    cv.addEventListener("pointerup", (e) => this.onUp(e));
    cv.addEventListener("pointercancel", (e) => this.onUp(e));
    cv.addEventListener("dblclick", (e) => this.onDouble(e));
    cv.addEventListener("contextmenu", (e) => { e.preventDefault(); this.openMenu(e); });
    cv.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.stage.addEventListener("dragover", (e) => {
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      this.stage.classList.add("gapc-dragging");
    });
    this.stage.addEventListener("dragleave", (e) => { e.stopPropagation(); this.stage.classList.remove("gapc-dragging"); });
    this.stage.addEventListener("drop", (e) => this.onDrop(e));
    this.keyUp = (e) => {
      if (e.code === "Space" && this.space) { this.space = false; this.cursor(); }
    };
    // capture phase: the workspace stops key events from bubbling out of itself
    window.addEventListener("keyup", this.keyUp, true);
    root.addEventListener("focusout", (e) => {
      if (!root.contains(e.relatedTarget) && this.space) { this.space = false; this.cursor(); }
    });
  }

  destroy() {
    window.removeEventListener("keyup", this.keyUp, true);
    this.root.remove();
  }

  resize() {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    if (!this.fitted) this.fit(); else this.draw();
  }

  setTool(tool) {
    this.closeOverlays();
    this.tool = tool;
    this.root.dataset.tool = tool;
    for (const [name, b] of Object.entries(this.toolButtons)) {
      b.classList.toggle("gapc-on", name === tool);
      b.setAttribute("aria-pressed", name === tool);
    }
    this.hint.textContent = HINTS[tool];
    this.cursor();
    this.draw();
  }

  setColor(color) {
    this.color = color;
    this.colorInput.value = color;
    this.swatches.forEach((s, i) => s.classList.toggle("gapc-on", COLORS[i] === color));
  }

  cursor() {
    const pan = this.space || this.tool === "hand";
    this.cv.style.cursor = pan ? (this.drag?.kind === "pan" ? "grabbing" : "grab") : { select: "default", pen: "crosshair", eraser: "cell", note: "copy" }[this.tool];
  }

  syncControls() {
    const s = this.scene;
    this.modelSelect.value = s.model;
    if (this.modelSelect.selectedIndex < 0) this.modelSelect.selectedIndex = 0;
    const custom = !RATIOS.includes(s.frame.ratio);
    this.customRatio.hidden = !custom;
    this.customRatio.textContent = `Custom ${s.frame.w}x${s.frame.h}`;
    this.ratioSelect.value = custom ? "custom" : s.frame.ratio;
    this.sizeSelect.value = s.frame.mp;
    this.layoutSelect.value = s.layout;
    this.setColor(this.color);
    this.undoButton.disabled = !this.past.length;
    this.redoButton.disabled = !this.future.length;
  }

  say(text) {
    this.toast.textContent = text;
    this.toast.classList.add("gapc-open");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove("gapc-open"), 3200);
  }

  toggleMax() {
    const max = !this.root.classList.contains("gapc-max");
    this.closeOverlays();
    (max ? document.body : this.host).append(this.root);
    this.root.classList.toggle("gapc-max", max);
    this.maxButton.classList.toggle("gapc-on", max);
    this.root.focus();
    this.fitted = false;
  }

  // ---------- scene ----------

  getScene() {
    return this.scene;
  }

  setScene(value) {
    let scene = value;
    if (typeof value === "string") {
      try { scene = value.trim() ? JSON.parse(value) : null; } catch { scene = null; }
    }
    const base = emptyScene(this.opts.defaultModel);
    this.scene = scene && Array.isArray(scene.items) ? { ...base, ...scene, frame: { ...base.frame, ...scene.frame } } : base;
    delete this.scene.renders;
    this.sel.clear();
    this.past = [];
    this.future = [];
    this.saved = JSON.stringify(this.scene);
    this.fitted = false;
    this.syncControls();
    this.resize();
    this.refreshCompile();
  }

  items(type) {
    return this.scene.items.filter((i) => i.type === type);
  }

  byId(id) {
    return this.scene.items.find((i) => i.id === id);
  }

  nextNumber(type) {
    const used = new Set(this.items(type).map((i) => i.n));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  isPlaced(item) {
    const f = this.scene.frame;
    return !item.refOnly && item.cx >= 0 && item.cx <= f.w && item.cy >= 0 && item.cy <= f.h;
  }

  // Runs a mutation and records it for undo.
  change(mutate) {
    if (mutate) mutate();
    this.commit();
  }

  commit() {
    const now = JSON.stringify(this.scene);
    if (now === this.saved) { this.draw(); return; }
    this.past.push(this.saved);
    if (this.past.length > HISTORY) this.past.shift();
    this.future = [];
    this.saved = now;
    this.afterChange();
  }

  afterChange() {
    for (const id of [...this.sel]) if (!this.byId(id)) this.sel.delete(id);
    this.syncControls();
    this.draw();
    this.opts.onChange?.();
    this.refreshCompile();
  }

  restore(from, to) {
    if (!from.length) return;
    this.closeOverlays();
    to.push(this.saved);
    this.saved = from.pop();
    this.scene = JSON.parse(this.saved);
    this.afterChange();
  }

  undo() { this.restore(this.past, this.future); }
  redo() { this.restore(this.future, this.past); }

  refreshCompile() {
    clearTimeout(this.compileTimer);
    this.compileTimer = setTimeout(async () => {
      if (!this.opts.compile) return;
      try {
        this.compiled = await this.opts.compile(this.scene);
      } catch {
        return;
      }
      this.promptText.textContent = this.compiled.prompt || "(empty - add a prompt, images or notes)";
      this.warnList.textContent = this.compiled.warnings.join("\n");
      this.warnList.style.whiteSpace = "pre-wrap";
      this.chips.replaceChildren();
      for (const slot of this.compiled.slots) {
        const item = slot.id && this.byId(slot.id);
        this.chips.append(el("span", "gapc-chip", { textContent: `${slot.token} = ${item ? "@" + item.type + item.n : "layout"}` }));
      }
      if (this.compiled.warnings.length) {
        this.chips.append(el("span", "gapc-chip gapc-warn", { textContent: `${this.compiled.warnings.length} warning${this.compiled.warnings.length > 1 ? "s" : ""}`, title: this.compiled.warnings.join("\n") }));
      }
    }, 250);
  }

  setFrame(ratio, mp) {
    const f = this.scene.frame;
    const next = RATIOS.includes(ratio) ? frameSize(ratio, mp) : (() => {
      const scale = Math.sqrt(mp * 1048576 / (f.w * f.h));
      return { w: Math.round(f.w * scale / 16) * 16, h: Math.round(f.h * scale / 16) * 16 };
    })();
    // keep the arrangement: positions follow the frame's new proportions, sizes its area
    const kx = next.w / f.w, ky = next.h / f.h, k = Math.sqrt(kx * ky);
    for (const item of this.scene.items) {
      if (item.type === "note") {
        item.x *= kx; item.y *= ky;
      } else {
        item.cx *= kx; item.cy *= ky;
        item.w *= k; item.h *= k;
      }
    }
    this.scene.frame = { ratio, mp, ...next };
    this.fitted = false;
    this.commit();
    this.resize();
  }

  useAsBase(item) {
    const f = this.scene.frame;
    const scale = Math.sqrt(f.mp * 1048576 / (item.w * item.h));
    const w = Math.max(16, Math.round(item.w * scale / 16) * 16), h = Math.max(16, Math.round(item.h * scale / 16) * 16);
    this.scene.frame = { ratio: "custom", mp: f.mp, w, h };
    Object.assign(item, { cx: w / 2, cy: h / 2, w, h, rot: 0, refOnly: false });
    this.scene.items = [item, ...this.scene.items.filter((i) => i !== item)];
    this.fitted = false;
    this.commit();
    this.resize();
  }

  // ---------- images ----------

  imageFor(item) {
    const key = item.file ? `${item.file.type}/${item.file.subfolder}/${item.file.name}` : item.id;
    let img = this.images.get(key);
    if (!img) {
      img = new Image();
      img.onload = () => this.draw();
      img.onerror = () => { img.failed = true; this.draw(); };
      img.src = item.file ? this.opts.viewUrl(item.file) : "";
      this.images.set(key, img);
    }
    return img;
  }

  async addFiles(files, at) {
    files = files.filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    const f = this.scene.frame;
    const centre = at || this.toWorld(this.stage.clientWidth / 2, this.stage.clientHeight / 2);
    const added = [];
    for (const [index, file] of files.entries()) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch {
        this.say(`Could not read ${file.name}`);
        URL.revokeObjectURL(url);
        continue;
      }
      const k = Math.min(1, 0.5 * Math.min(f.w, f.h) / Math.max(img.naturalWidth, img.naturalHeight)) || 1;
      const item = { id: uid(), type: "image", n: this.nextNumber("image"), cx: centre[0] + index * 32, cy: centre[1] + index * 32,
        w: img.naturalWidth * k, h: img.naturalHeight * k, rot: 0, nw: img.naturalWidth, nh: img.naturalHeight };
      this.images.set(item.id, img);
      this.scene.items.push(item);
      added.push(item);
      const job = this.opts.uploadImage(file).then((ref) => {
        item.file = ref;
        this.images.set(`${ref.type}/${ref.subfolder}/${ref.name}`, img);
      }).catch(() => {
        this.scene.items = this.scene.items.filter((i) => i !== item);
        this.say(`Upload failed: ${file.name}`);
      }).finally(() => this.pending.delete(job));
      this.pending.add(job);
    }
    this.draw();
    await Promise.all([...this.pending]);
    this.sel = new Set(added.filter((i) => this.byId(i.id)).map((i) => i.id));
    this.setTool("select");
    this.commit();
  }

  onDrop(e) {
    e.preventDefault(); e.stopPropagation();
    this.stage.classList.remove("gapc-dragging");
    const at = this.toWorld(...this.local(e));
    const files = [...e.dataTransfer.files];
    if (files.length) { this.addFiles(files, at); return; }
    const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (/^(https?:|blob:|data:image)/.test(url)) {
      fetch(url).then((r) => r.blob()).then((blob) => {
        if (!blob.type.startsWith("image/")) throw new Error();
        this.addFiles([new File([blob], "dropped." + blob.type.split("/")[1].split("+")[0], { type: blob.type })], at);
      }).catch(() => this.say("That image could not be fetched. Save it and drop the file instead."));
    }
  }

  onPaste(e) {
    if (e.target.closest?.(".gapc-edit")) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    e.stopPropagation();
    if (files.length) { e.preventDefault(); this.addFiles(files); }
  }

  // ---------- geometry ----------

  local(e) {
    const r = this.cv.getBoundingClientRect();
    const k = r.width ? this.cv.clientWidth / r.width : 1;   // the node around us may be CSS-scaled
    return [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
  }

  toWorld(sx, sy) {
    return [(sx - this.view.x) / this.view.z, (sy - this.view.y) / this.view.z];
  }

  toScreen(x, y) {
    return [x * this.view.z + this.view.x, y * this.view.z + this.view.y];
  }

  fit() {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (!w || !h) return;
    const f = this.scene.frame;
    let x0 = 0, y0 = 0, x1 = f.w, y1 = f.h;
    for (const item of this.scene.items) {
      const b = item.type === "note" ? [item.x, item.y, item.x, item.y] : aabb(item);
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
    }
    const pad = Math.min(56, w * 0.08);
    const z = Math.max(0.02, Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad - 14) / (y1 - y0)));
    this.view = { z, x: (w - (x0 + x1) * z) / 2, y: (h - 14 - (y0 + y1) * z) / 2 };
    this.fitted = true;
    this.draw();
  }

  zoomAt(sx, sy, factor) {
    const z = Math.max(0.02, Math.min(16, this.view.z * factor));
    const [wx, wy] = this.toWorld(sx, sy);
    this.view = { z, x: sx - wx * z, y: sy - wy * z };
    this.closeOverlays();
    this.draw();
  }

  hitNote(sx, sy) {
    return [...this.items("note")].reverse().find((n) => {
      const [x, y] = this.toScreen(n.x, n.y);
      return Math.hypot(sx - x, sy - y) <= 13;
    });
  }

  hitItem(wx, wy) {
    return [...this.scene.items].reverse().find((i) => i.type !== "note" && contains(i, wx, wy));
  }

  handles(item) {
    const out = [];
    for (const [hx, hy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const [x, y] = rotate(hx * item.w / 2, hy * item.h / 2, item.rot || 0);
      out.push({ kind: "resize", hx, hy, pos: this.toScreen(item.cx + x, item.cy + y) });
    }
    const [x, y] = rotate(0, -item.h / 2 - 26 / this.view.z, item.rot || 0);
    out.push({ kind: "rotate", pos: this.toScreen(item.cx + x, item.cy + y) });
    return out;
  }

  single() {
    if (this.sel.size !== 1) return null;
    const item = this.byId([...this.sel][0]);
    return item && item.type !== "note" ? item : null;
  }

  // ---------- pointer ----------

  onDown(e) {
    this.root.focus({ preventScroll: true });
    this.closeOverlays();
    if (e.button === 2) return;
    this.cv.setPointerCapture(e.pointerId);
    const [sx, sy] = this.local(e);
    this.pointers.set(e.pointerId, [sx, sy]);
    if (this.pointers.size === 2) {
      // second finger: turn whatever started into a pinch
      if (this.drag?.kind === "stroke") this.drag = null;
      const [a, b] = [...this.pointers.values()];
      this.drag = { kind: "pinch", dist: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      return;
    }
    const [wx, wy] = this.toWorld(sx, sy);
    if (this.space || this.tool === "hand") {
      this.drag = { kind: "pan", sx, sy, view: { ...this.view } };
      this.cursor();
      return;
    }
    if (this.tool === "pen") {
      this.drag = { kind: "stroke", pts: [wx, wy], last: [sx, sy] };
    } else if (this.tool === "eraser") {
      this.drag = { kind: "erase" };
      this.eraseAt(wx, wy);
    } else if (this.tool === "note") {
      this.drag = { kind: "note", at: [wx, wy] };
    } else {
      this.startSelect(e, sx, sy, wx, wy);
    }
    this.draw();
  }

  startSelect(e, sx, sy, wx, wy) {
    const one = this.single();
    const handle = one && this.handles(one).find((h) => Math.hypot(sx - h.pos[0], sy - h.pos[1]) <= 9);
    if (handle) {
      const [ax, ay] = handle.kind === "resize" ? rotate(-handle.hx * one.w / 2, -handle.hy * one.h / 2, one.rot || 0) : [0, 0];
      this.drag = { kind: handle.kind, item: one, hx: handle.hx, hy: handle.hy, anchor: [one.cx + ax, one.cy + ay], w: one.w, h: one.h };
      return;
    }
    const hit = this.hitNote(sx, sy) || this.hitItem(wx, wy);
    if (!hit) {
      if (!e.shiftKey) this.sel.clear();
      this.drag = { kind: "marquee", from: [wx, wy], to: [wx, wy], keep: new Set(this.sel) };
      return;
    }
    if (e.shiftKey) {
      if (this.sel.has(hit.id)) this.sel.delete(hit.id); else this.sel.add(hit.id);
    } else if (!this.sel.has(hit.id)) {
      this.sel = new Set([hit.id]);
    }
    this.drag = { kind: "move", last: [wx, wy] };
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const [sx, sy] = this.local(e);
    this.pointers.set(e.pointerId, [sx, sy]);
    const d = this.drag;
    if (!d) return;
    const [wx, wy] = this.toWorld(sx, sy);
    if (d.kind === "pinch") {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.view.x += mid[0] - d.mid[0]; this.view.y += mid[1] - d.mid[1];
      this.zoomAt(mid[0], mid[1], dist / (d.dist || 1));
      d.dist = dist; d.mid = mid;
      return;
    }
    if (d.kind === "pan") {
      this.view.x = d.view.x + sx - d.sx; this.view.y = d.view.y + sy - d.sy;
    } else if (d.kind === "stroke") {
      if (Math.hypot(sx - d.last[0], sy - d.last[1]) >= 1.5) { d.pts.push(wx, wy); d.last = [sx, sy]; }
    } else if (d.kind === "erase") {
      this.eraseAt(wx, wy);
    } else if (d.kind === "move") {
      const dx = wx - d.last[0], dy = wy - d.last[1];
      for (const id of this.sel) {
        const item = this.byId(id);
        if (item.type === "note") { item.x += dx; item.y += dy; } else { item.cx += dx; item.cy += dy; }
      }
      d.last = [wx, wy];
    } else if (d.kind === "resize") {
      const item = d.item;
      const [lx, ly] = rotate(wx - d.anchor[0], wy - d.anchor[1], -(item.rot || 0));
      const min = 8 / this.view.z;
      let w = Math.max(min, d.hx * lx), h = Math.max(min, d.hy * ly);
      if (!e.shiftKey) {
        const k = Math.max(w / d.w, h / d.h);
        w = d.w * k; h = d.h * k;
      }
      const [cx, cy] = rotate(d.hx * w / 2, d.hy * h / 2, item.rot || 0);
      Object.assign(item, { w, h, cx: d.anchor[0] + cx, cy: d.anchor[1] + cy });
    } else if (d.kind === "rotate") {
      let angle = Math.atan2(wy - d.item.cy, wx - d.item.cx) + Math.PI / 2;
      const step = Math.PI / 12;
      if (e.shiftKey) angle = Math.round(angle / step) * step;
      else if (Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))) < 0.05) angle = 0;
      d.item.rot = Math.atan2(Math.sin(angle), Math.cos(angle));
    } else if (d.kind === "marquee") {
      d.to = [wx, wy];
      const x0 = Math.min(d.from[0], wx), x1 = Math.max(d.from[0], wx), y0 = Math.min(d.from[1], wy), y1 = Math.max(d.from[1], wy);
      this.sel = new Set(d.keep);
      for (const item of this.scene.items) {
        const b = item.type === "note" ? [item.x, item.y, item.x, item.y] : aabb(item);
        if (b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0) this.sel.add(item.id);
      }
    }
    this.draw();
  }

  onUp(e) {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.cv.hasPointerCapture(e.pointerId)) this.cv.releasePointerCapture(e.pointerId);
    const d = this.drag;
    if (!d || (d.kind === "pinch" && this.pointers.size)) return;
    this.drag = null;
    if (d.kind === "stroke") this.endStroke(d.pts);
    // the note editor opens on release, once the press has finished moving focus
    if (d.kind === "note") { this.addNote(...d.at); return; }
    this.cursor();
    this.commit();
  }

  onDouble(e) {
    const [sx, sy] = this.local(e);
    const note = this.hitNote(sx, sy);
    if (note) this.editNote(note);
    else if (this.tool === "select") {
      const item = this.hitItem(...this.toWorld(sx, sy));
      if (item) this.editName(item);
    }
  }

  onWheel(e) {
    // until the workspace is clicked the wheel belongs to the graph around it
    if (!this.root.contains(document.activeElement)) return;
    e.preventDefault();
    e.stopPropagation();
    const [sx, sy] = this.local(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    this.zoomAt(sx, sy, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0016)));
  }

  onKey(e) {
    e.stopPropagation();
    if (e.target.closest?.(".gapc-edit, .gapc-select, input")) return;
    if (e.target.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = () => e.preventDefault();
    if (key === "Escape") {
      if (this.menu || this.editor) this.closeOverlays();
      else if (this.panel.classList.contains("gapc-open")) this.panel.classList.remove("gapc-open");
      else if (this.sel.size) { this.sel.clear(); this.draw(); }
      else if (this.root.classList.contains("gapc-max")) this.toggleMax();
      return done();
    }
    if (mod && key === "z") { if (e.shiftKey) this.redo(); else this.undo(); return done(); }
    if (mod && key === "y") { this.redo(); return done(); }
    if (mod && key === "a") { this.sel = new Set(this.scene.items.map((i) => i.id)); this.setTool("select"); return done(); }
    if (mod && key === "d") { this.duplicate(); return done(); }
    if (mod) return;
    if (key === "Delete" || key === "Backspace") { this.removeSelected(); return done(); }
    if (e.code === "Space") { this.space = true; this.cursor(); return done(); }
    if (key.startsWith("Arrow") && this.sel.size) {
      const step = (e.shiftKey ? 10 : 1) / Math.min(1, this.view.z);
      const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
      this.change(() => {
        for (const id of this.sel) {
          const item = this.byId(id);
          if (item.type === "note") { item.x += dx; item.y += dy; } else { item.cx += dx; item.cy += dy; }
        }
      });
      return done();
    }
    const tool = { v: "select", b: "pen", e: "eraser", n: "note", h: "hand" }[key];
    if (tool) { this.setTool(tool); return done(); }
    if (key === "f") { this.fit(); return done(); }
    if (key === "[" || key === "]") {
      this.size = Math.max(1, Math.min(60, this.size + (key === "]" ? 2 : -2)));
      this.sizeInput.value = this.size;
      return done();
    }
  }

  // ---------- editing ----------

  endStroke(world) {
    if (world.length === 2) world.push(world[0] + 0.01, world[1] + 0.01);
    const size = this.size / this.view.z;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < world.length; i += 2) {
      x0 = Math.min(x0, world[i]); x1 = Math.max(x1, world[i]); y0 = Math.min(y0, world[i + 1]); y1 = Math.max(y1, world[i + 1]);
    }
    const reach = 40 / this.view.z + size;
    const near = [...this.items("sketch")].reverse().find((s) => {
      const b = aabb(s);
      return b[0] - reach <= x1 && b[2] + reach >= x0 && b[1] - reach <= y1 && b[3] + reach >= y0;
    });
    if (near) {
      const kx = near.bw / near.w, ky = near.bh / near.h;
      const p = [];
      for (let i = 0; i < world.length; i += 2) {
        const [lx, ly] = toLocal(near, world[i], world[i + 1]);
        p.push(lx * kx + near.bw / 2, ly * ky + near.bh / 2);
      }
      near.strokes.push({ c: this.color, s: size * Math.sqrt(kx * ky), p });
      refitSketch(near);
      this.sel = new Set([near.id]);
      return;
    }
    const pad = size / 2;
    const w = x1 - x0 + size, h = y1 - y0 + size;
    const p = world.map((v, i) => v - (i % 2 ? y0 : x0) + pad);
    const item = { id: uid(), type: "sketch", n: this.nextNumber("sketch"), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w, h, bw: w, bh: h, rot: 0, strokes: [{ c: this.color, s: size, p }] };
    this.scene.items.push(item);
    this.sel = new Set([item.id]);
  }

  eraseAt(wx, wy) {
    const radius = this.size / 2 / this.view.z + 4 / this.view.z;
    for (const item of this.items("sketch")) {
      const kx = item.bw / item.w, ky = item.bh / item.h;
      const [lx, ly] = toLocal(item, wx, wy);
      const px = lx * kx + item.bw / 2, py = ly * ky + item.bh / 2, r = radius * Math.sqrt(kx * ky);
      const before = item.strokes.length;
      item.strokes = item.strokes.filter((st) => {
        for (let i = 0; i + 3 < st.p.length; i += 2) {
          if (segmentDistance(px, py, st.p[i], st.p[i + 1], st.p[i + 2], st.p[i + 3]) <= r + st.s / 2) return false;
        }
        return true;
      });
      if (!item.strokes.length) this.scene.items = this.scene.items.filter((i) => i !== item);
      else if (item.strokes.length !== before) refitSketch(item);
    }
  }

  addNote(wx, wy) {
    const note = { id: uid(), type: "note", n: this.nextNumber("note"), x: wx, y: wy, text: "" };
    this.scene.items.push(note);
    this.sel = new Set([note.id]);
    this.draw();
    this.editNote(note);
  }

  removeSelected() {
    if (!this.sel.size) return;
    this.change(() => {
      this.scene.items = this.scene.items.filter((i) => !this.sel.has(i.id));
      this.sel.clear();
    });
  }

  duplicate() {
    if (!this.sel.size) return;
    this.change(() => {
      const copies = [];
      const shift = 28 / this.view.z;
      for (const item of this.scene.items.filter((i) => this.sel.has(i.id))) {
        const copy = { ...JSON.parse(JSON.stringify(item)), id: uid(), n: this.nextNumber(item.type) };
        if (copy.type === "note") { copy.x += shift; copy.y += shift; } else { copy.cx += shift; copy.cy += shift; }
        this.scene.items.push(copy);
        copies.push(copy.id);
      }
      this.sel = new Set(copies);
    });
  }

  reorder(front) {
    this.change(() => {
      const picked = this.scene.items.filter((i) => this.sel.has(i.id)), rest = this.scene.items.filter((i) => !this.sel.has(i.id));
      this.scene.items = front ? [...rest, ...picked] : [...picked, ...rest];
    });
  }

  // ---------- overlays ----------

  closeOverlays() {
    this.menu?.remove();
    this.menu = null;
    if (this.editor) {
      const done = this.editor.done;
      this.editor = null;
      done(true);
    }
  }

  place(node, sx, sy) {
    this.stage.append(node);
    node.style.left = Math.max(4, Math.min(sx, this.stage.clientWidth - node.offsetWidth - 4)) + "px";
    node.style.top = Math.max(4, Math.min(sy, this.stage.clientHeight - node.offsetHeight - 4)) + "px";
  }

  openEditor(node, sx, sy, save) {
    this.closeOverlays();
    node.done = (keep) => {
      node.done = () => {};
      this.editor = null;
      node.remove();
      save(keep ? node.value.trim() : null);
      this.root.focus({ preventScroll: true });
    };
    node.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); node.done(false); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); node.done(true); }
    });
    node.addEventListener("blur", () => node.done(true));
    for (const type of ["pointerdown", "paste"]) node.addEventListener(type, (e) => e.stopPropagation());
    this.place(node, sx, sy);
    this.editor = node;
    node.focus();
    node.select();
  }

  editNote(note) {
    const [sx, sy] = this.toScreen(note.x, note.y);
    const area = el("textarea", "gapc-edit", { rows: 3, value: note.text, placeholder: "Instruction for this spot...\nEnter saves, Shift+Enter adds a line" });
    area.setAttribute("aria-label", "Note text");
    this.editingId = note.id;
    this.openEditor(area, sx + 16, sy - 14, (text) => {
      this.editingId = null;
      if (text !== null) note.text = text;
      if (!note.text) this.scene.items = this.scene.items.filter((i) => i !== note);
      this.commit();
    });
  }

  editName(item) {
    const b = aabb(item);
    const [sx, sy] = this.toScreen(b[0], b[1]);
    const input = el("input", "gapc-edit gapc-name", { type: "text", value: item.name || "", placeholder: "Name it, e.g. tree", maxLength: 60 });
    input.setAttribute("aria-label", "Item name");
    this.openEditor(input, sx, sy - 34, (text) => {
      if (text !== null) item.name = text;
      this.commit();
    });
  }

  openMenu(e) {
    this.closeOverlays();
    const [sx, sy] = this.local(e);
    const [wx, wy] = this.toWorld(sx, sy);
    const note = this.hitNote(sx, sy);
    const item = note ? null : this.hitItem(wx, wy);
    const target = note || item;
    if (target && !this.sel.has(target.id)) this.sel = new Set([target.id]);
    if (!target) this.sel.clear();
    this.draw();
    const menu = el("div", "gapc-menu");
    menu.setAttribute("role", "menu");
    const add = (label, run, extra, cls) => {
      const b = el("button", cls || "", { type: "button" });
      b.setAttribute("role", "menuitem");
      b.append(label, el("span", "", { textContent: extra || "" }));
      b.addEventListener("click", () => { this.closeOverlays(); run(); });
      menu.append(b);
    };
    const line = () => menu.append(el("hr"));
    if (note) {
      add("Edit note", () => this.editNote(note), "double-click");
    } else {
      add("Add note here", () => this.addNote(wx, wy), "N");
    }
    if (item) {
      line();
      add(item.name ? "Rename" : "Name this item", () => this.editName(item), "double-click");
      add(item.refOnly ? "Place in the picture" : "Use as reference only", () => this.change(() => { item.refOnly = !item.refOnly; }), item.refOnly ? "on" : "");
      if (item.type === "image") {
        add("Use as base image (fit frame)", () => this.useAsBase(item));
        add("Flip horizontally", () => this.change(() => { item.flip = !item.flip; }));
      }
      add("Reset rotation", () => this.change(() => { item.rot = 0; }));
      line();
      add("Bring to front", () => this.reorder(true));
      add("Send to back", () => this.reorder(false));
    }
    if (target) {
      add("Duplicate", () => this.duplicate(), "Ctrl+D");
      line();
      add("Delete", () => this.removeSelected(), "Del", "gapc-danger");
    } else {
      add("Add image...", () => this.fileInput.click());
      add("Fit view", () => this.fit(), "F");
      line();
      add("Clear canvas", () => this.change(() => { this.scene.items = []; this.sel.clear(); }), "", "gapc-danger");
    }
    for (const type of ["pointerdown", "contextmenu"]) menu.addEventListener(type, (ev) => { ev.stopPropagation(); if (type === "contextmenu") ev.preventDefault(); });
    this.place(menu, sx, sy);
    this.menu = menu;
    menu.querySelector("button").focus({ preventScroll: true });
    menu.addEventListener("keydown", (ev) => {
      const buttons = [...menu.querySelectorAll("button")], at = buttons.indexOf(document.activeElement);
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault(); ev.stopPropagation();
        buttons[(at + (ev.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length].focus();
      }
    });
  }

  // ---------- painting ----------

  paintItem(ctx, item) {
    ctx.save();
    ctx.translate(item.cx, item.cy);
    ctx.rotate(item.rot || 0);
    if (item.type === "image") {
      const img = this.images.get(item.id) || this.imageFor(item);
      if (item.flip) ctx.scale(-1, 1);
      if (img.complete && img.naturalWidth) {
        ctx.drawImage(img, -item.w / 2, -item.h / 2, item.w, item.h);
      } else {
        ctx.fillStyle = "#3a3d46";
        ctx.fillRect(-item.w / 2, -item.h / 2, item.w, item.h);
        ctx.fillStyle = "#c8ccd6";
        ctx.font = `${Math.max(10, Math.min(item.w, item.h) / 8)}px ${FONT}`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        if (item.flip) ctx.scale(-1, 1);
        ctx.fillText(img.failed ? "missing image" : "loading...", 0, 0);
      }
    } else {
      ctx.scale(item.w / item.bw, item.h / item.bh);
      ctx.translate(-item.bw / 2, -item.bh / 2);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (const st of item.strokes) {
        const p = st.p;
        ctx.strokeStyle = st.c; ctx.lineWidth = st.s;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        for (let i = 2; i + 3 < p.length; i += 2) ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
        ctx.lineTo(p[p.length - 2], p[p.length - 1]);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Pins and badges are drawn in pixel space so they keep their size at any zoom; k scales them for exports.
  paintBadge(ctx, x, y, text, color, k) {
    ctx.font = `600 ${11 * k}px ${FONT}`;
    const w = ctx.measureText(text).width + 10 * k;
    roundRect(ctx, x, y, w, 17 * k, 4 * k);
    ctx.fillStyle = color; ctx.fill();
    ctx.fillStyle = "#0e1013"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(text, x + 5 * k, y + 9 * k);
  }

  paintPin(ctx, x, y, n, k, active) {
    ctx.beginPath();
    ctx.arc(x, y, 11 * k, 0, Math.PI * 2);
    ctx.fillStyle = NOTE_COLOR; ctx.fill();
    ctx.lineWidth = (active ? 3 : 2) * k; ctx.strokeStyle = active ? "#ffffff" : "#1a1206"; ctx.stroke();
    ctx.fillStyle = "#1a1206"; ctx.font = `700 ${12 * k}px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(n), x, y + 0.5 * k);
  }

  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  render() {
    const ctx = this.ctx, dpr = window.devicePixelRatio || 1, v = this.view, f = this.scene.frame;
    const W = this.cv.width / dpr, H = this.cv.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#17181c";
    ctx.fillRect(0, 0, W, H);
    const [fx, fy] = this.toScreen(0, 0), fw = f.w * v.z, fh = f.h * v.z;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.5)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(fx, fy, fw, fh);
    ctx.restore();

    ctx.save();
    ctx.translate(v.x, v.y); ctx.scale(v.z, v.z);
    for (const item of this.scene.items) if (item.type !== "note") this.paintItem(ctx, item);
    if (this.drag?.kind === "stroke") {
      const p = this.drag.pts;
      ctx.strokeStyle = this.color; ctx.lineWidth = this.size / v.z; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
      if (p.length === 2) ctx.lineTo(p[0] + 0.01, p[1] + 0.01);
      ctx.stroke();
    }
    ctx.restore();

    // everything outside the frame is the reference shelf: dim it slightly and outline the frame
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect(fx, fy, fw, fh);
    ctx.fillStyle = "rgba(23,24,28,.28)"; ctx.fill("evenodd");
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5; ctx.strokeRect(fx, fy, fw, fh);
    // under the frame, where item badges never cover it
    ctx.fillStyle = "#aab2c0"; ctx.font = `11px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`Picture frame  ${f.w} x ${f.h}`, fx, fy + fh + 6);
    ctx.restore();

    if (!this.scene.items.length && !this.drag) {
      ctx.fillStyle = "#7b8190"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `13px ${FONT}`;
      const lines = wrapText(ctx, "Drop images here, draw, or right-click to pin a note.\nInside the frame is the picture. Outside it is reference only.", Math.max(60, fw - 24), 8);
      lines.forEach((l, i) => ctx.fillText(l, fx + fw / 2, fy + fh / 2 + (i - (lines.length - 1) / 2) * 18));
    }

    for (const item of this.scene.items) {
      if (item.type === "note") continue;
      const b = aabb(item);
      const [x, y] = this.toScreen(b[0], b[1]);
      const text = `@${item.type}${item.n}${item.name ? "  " + item.name : ""}${this.isPlaced(item) ? "" : "  - reference"}`;
      this.paintBadge(ctx, x, y - 19, text, this.sel.has(item.id) ? ACCENT : "#c9ced8", 1);
    }

    ctx.lineWidth = 1.5; ctx.strokeStyle = ACCENT;
    for (const id of this.sel) {
      const item = this.byId(id);
      if (!item || item.type === "note") continue;
      ctx.save();
      ctx.translate(...this.toScreen(item.cx, item.cy));
      ctx.rotate(item.rot || 0);
      ctx.strokeRect(-item.w * v.z / 2, -item.h * v.z / 2, item.w * v.z, item.h * v.z);
      ctx.restore();
    }
    const one = this.tool === "select" && this.single();
    if (one) {
      const hs = this.handles(one);
      const top = this.toScreen(...(() => { const [x, y] = rotate(0, -one.h / 2, one.rot || 0); return [one.cx + x, one.cy + y]; })());
      ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(hs[4].pos[0], hs[4].pos[1]); ctx.stroke();
      for (const h of hs) {
        ctx.beginPath();
        if (h.kind === "rotate") ctx.arc(h.pos[0], h.pos[1], 5.5, 0, Math.PI * 2); else ctx.rect(h.pos[0] - 4.5, h.pos[1] - 4.5, 9, 9);
        ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.stroke();
      }
    }

    for (const note of this.items("note")) {
      const [x, y] = this.toScreen(note.x, note.y);
      if (note.text && this.editingId !== note.id) {
        ctx.font = `12px ${FONT}`;
        const lines = wrapText(ctx, note.text, 200, 3);
        const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14, h = lines.length * 15 + 8;
        roundRect(ctx, x + 15, y - 12, w, h, 6);
        ctx.fillStyle = "rgba(24,26,31,.93)"; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = this.sel.has(note.id) ? "#ffffff" : NOTE_COLOR; ctx.stroke();
        ctx.fillStyle = "#f2f3f5"; ctx.textAlign = "left"; ctx.textBaseline = "top";
        lines.forEach((l, i) => ctx.fillText(l, x + 22, y - 8 + i * 15));
      }
      this.paintPin(ctx, x, y, note.n, 1, this.sel.has(note.id));
    }

    if (this.drag?.kind === "marquee") {
      const [ax, ay] = this.toScreen(...this.drag.from), [bx, by] = this.toScreen(...this.drag.to);
      ctx.fillStyle = "rgba(110,168,254,.14)"; ctx.strokeStyle = ACCENT; ctx.lineWidth = 1;
      ctx.fillRect(ax, ay, bx - ax, by - ay); ctx.strokeRect(ax, ay, bx - ax, by - ay);
    }
  }

  // ---------- export ----------

  renderFrame(annotated) {
    const f = this.scene.frame;
    const cv = el("canvas", "", { width: f.w, height: f.h });
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, f.w, f.h);
    const placed = this.scene.items.filter((i) => i.type !== "note" && this.isPlaced(i));
    for (const item of placed) this.paintItem(ctx, item);
    if (annotated) {
      const k = Math.max(f.w, f.h) / 900;
      for (const item of placed) {
        const b = aabb(item);
        this.paintBadge(ctx, Math.max(2, b[0]), Math.max(2, b[1]), `@${item.type}${item.n}${item.name ? " " + item.name : ""}`, "#c9ced8", k);
      }
      for (const note of this.items("note")) {
        if (note.x >= 0 && note.x <= f.w && note.y >= 0 && note.y <= f.h) this.paintPin(ctx, note.x, note.y, note.n, k, false);
      }
    }
    return cv;
  }

  renderSketch(item) {
    const k = 1024 / Math.max(item.w, item.h), pad = 48;
    const cv = el("canvas", "", { width: Math.round(item.w * k) + 2 * pad, height: Math.round(item.h * k) + 2 * pad });
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.translate(cv.width / 2, cv.height / 2);
    ctx.scale(k, k);
    this.paintItem(ctx, { ...item, cx: 0, cy: 0, rot: 0 });
    return cv;
  }

  // Called when the workflow is queued: uploads the frame renders and returns the scene that goes to the backend.
  async prepare() {
    this.closeOverlays();
    await Promise.all([...this.pending]);
    const images = this.items("image");
    await Promise.all(images.map((item) => {
      const img = this.images.get(item.id) || this.imageFor(item);
      return img.complete ? null : new Promise((resolve) => { img.addEventListener("load", resolve, { once: true }); img.addEventListener("error", resolve, { once: true }); });
    }));
    const { model, layout, ...visual } = this.scene;
    const key = hash(JSON.stringify(visual));
    if (this.renders.key !== key) {
      const renders = { key, annotated: `render_${key}_a.png`, layout: `render_${key}_l.png`, sketches: {} };
      const jobs = [[renders.annotated, this.renderFrame(true)], [renders.layout, this.renderFrame(false)]];
      for (const item of this.items("sketch")) {
        if (this.isPlaced(item)) continue;
        renders.sketches[item.id] = `render_${key}_s${item.id}.png`;
        jobs.push([renders.sketches[item.id], this.renderSketch(item)]);
      }
      for (const [name, cv] of jobs) {
        if (this.uploaded.has(name)) continue;
        const blob = await new Promise((resolve) => cv.toBlob(resolve, "image/png"));
        await this.opts.uploadRender(blob, name);
        this.uploaded.add(name);
      }
      this.renders = renders;
    }
    return { ...this.scene, items: this.scene.items.filter((i) => i.type !== "image" || i.file), renders: this.renders };
  }
}
