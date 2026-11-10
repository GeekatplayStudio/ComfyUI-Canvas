#!/usr/bin/env node
/*
 * Geekatplay Canvas end-to-end check. Drives the real node in headless Chrome over the
 * DevTools protocol with real mouse and keyboard events, once with Nodes 2.0 (Vue nodes)
 * and once with the classic renderer.
 *
 *   node tests/e2e/canvas_e2e.mjs --base=http://127.0.0.1:8188 [--out=dir] [--chrome=path]
 *
 * It flips the Comfy.VueNodes.Enabled setting while it runs and puts it back at the end.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = "1"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));
const BASE = (args.base ?? "http://127.0.0.1:8188").replace(/\/$/, "");
const OUT = path.resolve(args.out ?? path.join(os.tmpdir(), "geekatplay-canvas-e2e"));
const PORT = Number(args.port ?? 9334);
const CHROME = args.chrome ?? [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);
const CTRL = 2, SHIFT = 8;

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const pageErrors = [];
let mode = "";

function check(name, ok, detail = "") {
  results.push({ name: `[${mode}] ${name}`, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  [${mode}] ${name}${detail !== "" ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      this.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id && this.pending.has(message.id)) {
          const { resolve: ok, reject: fail } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) fail(new Error(message.error.message));
          else ok(message.result);
        } else if (message.method === "Page.javascriptDialogOpening") {
          // "leave site?" when the second pass reloads a modified workflow
          this.send("Page.handleJavaScriptDialog", { accept: true });
        } else if (message.method === "Runtime.exceptionThrown") {
          pageErrors.push(`[${mode}] ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
        }
      };
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(expression) {
    const result = await Promise.race([
      this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
      sleep(90000).then(() => { throw new Error(`Page script timed out: ${expression.slice(0, 160)}`); }),
    ]);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async waitFor(expression, timeout = 30000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      await sleep(200);
    }
    throw new Error(`Timed out waiting for ${expression.slice(0, 200)} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
  }

  async screenshot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
  }

  mouse(type, x, y, extra = {}) {
    return this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
  }

  async drag(from, to, modifiers = 0, steps = 8) {
    await this.mouse("mouseMoved", from[0], from[1], { buttons: 0, modifiers });
    await this.mouse("mousePressed", from[0], from[1], { modifiers });
    for (let i = 1; i <= steps; i++) {
      await this.mouse("mouseMoved", from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps, { modifiers });
    }
    await this.mouse("mouseReleased", to[0], to[1], { modifiers });
    await sleep(120);
  }

  async click(point, extra = {}) {
    await this.mouse("mouseMoved", point[0], point[1], { buttons: 0 });
    await this.mouse("mousePressed", point[0], point[1], extra);
    await this.mouse("mouseReleased", point[0], point[1], extra);
    await sleep(120);
  }

  async key(key, modifiers = 0) {
    const special = { Enter: [13, "Enter", "\r"], Escape: [27, "Escape"], Delete: [46, "Delete"], " ": [32, "Space", " "] }[key];
    const code = special ? special[1] : `Key${key.toUpperCase()}`;
    const vk = special ? special[0] : key.toUpperCase().charCodeAt(0);
    const text = modifiers & CTRL ? undefined : special ? special[2] : key;
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers, text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(100);
  }

  type(text) {
    return this.send("Input.insertText", { text });
  }
}

// page-side helpers, all through the workspace the node exposes
const WS = "window.gapNode.gapCanvas";
const at = (cdp, x, y) => cdp.eval(`(() => { const ws = ${WS}, r = ws.cv.getBoundingClientRect(), k = r.width / ws.cv.clientWidth, [sx, sy] = ws.toScreen(${x}, ${y}); return [r.left + sx * k, r.top + sy * k]; })()`);
const state = (cdp) => cdp.eval(`(() => { const ws = ${WS}; return {
  items: ws.scene.items.map((i) => ({ ...i, strokes: i.strokes ? i.strokes.length : undefined })),
  frame: ws.scene.frame, model: ws.scene.model, tool: ws.tool, sel: [...ws.sel], past: ws.past.length, future: ws.future.length, view: { ...ws.view },
  nodes: app.graph._nodes.length, nodePos: [...window.gapNode.pos], graph: [app.canvas.ds.scale, ...app.canvas.ds.offset],
  editor: !!ws.editor, menu: !!ws.menu, compiled: ws.compiled }; })()`);
const find = (s, type, n) => s.items.find((i) => i.type === type && i.n === n);
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

async function setup(cdp, vue) {
  await fetch(`${BASE}/api/settings/Comfy.VueNodes.Enabled`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(vue) });
  await cdp.send("Page.navigate", { url: BASE });
  await cdp.waitFor("window.app?.graph && window.LiteGraph?.registered_node_types?.GeekatplayCanvas && !!document.querySelector('canvas')");
  // a starting workflow may still be loading, which would replace the node: add it until it sticks
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(1500);
    await cdp.eval(`(() => {
      app.graph.clear();
      const node = LiteGraph.createNode("GeekatplayCanvas");
      node.pos = [320, 40];
      app.graph.add(node);
      window.gapNode = node;
      app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, -210];
      app.canvas.setDirty(true, true);
    })()`);
    await sleep(1500);
    if (await cdp.eval(`app.graph._nodes.length === 1 && app.graph._nodes[0] === window.gapNode && !!${WS}`)) break;
  }
  await cdp.waitFor(`${WS} && ${WS}.stage.clientHeight > 200 && ${WS}.fitted`);
  await sleep(600);
}

async function addImage(cdp, name, w, h, color, x, y) {
  await cdp.eval(`(async () => {
    const c = document.createElement("canvas"); c.width = ${w}; c.height = ${h};
    const g = c.getContext("2d"); g.fillStyle = "${color}"; g.fillRect(0, 0, ${w}, ${h}); g.fillStyle = "#fff"; g.font = "bold 64px sans-serif"; g.fillText("${name}", 24, 90);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    await ${WS}.addFiles([new File([blob], "gapc_e2e_${name}.png", { type: "image/png" })], [${x}, ${y}]);
  })()`);
}

async function run(cdp, vue) {
  mode = vue ? "nodes 2.0" : "classic";
  await setup(cdp, vue);
  let s = await state(cdp);
  check("node and workspace are created", s.nodes === 1 && s.items.length === 0, await cdp.eval(`[${WS}.stage.clientWidth, ${WS}.stage.clientHeight]`));
  check("Vue nodes setting matches the mode", (await cdp.eval("app.ui.settings.getSettingValue('Comfy.VueNodes.Enabled')")) === vue);

  // images
  await addImage(cdp, "tree", 600, 800, "#2e7d32", 700, 500);
  await addImage(cdp, "girl", 400, 700, "#c2185b", 250, 600);
  await cdp.eval(`${WS}.fit()`);
  await sleep(300);
  s = await state(cdp);
  const tree0 = find(s, "image", 1);
  check("uploaded images land on the canvas with file refs", s.items.length === 2 && tree0.file?.subfolder === "geekatplay_canvas" && Object.keys(tree0.file).length === 3, tree0.file);
  const before = s;

  // move
  await cdp.drag(await at(cdp, 700, 500), await at(cdp, 760, 420));
  s = await state(cdp);
  let tree = find(s, "image", 1);
  check("dragging moves the image", near(tree.cx, 760, 6) && near(tree.cy, 420, 6), [tree.cx, tree.cy]);
  check("the graph node and view stay put", s.nodePos.join() === before.nodePos.join() && s.graph.join() === before.graph.join() && s.nodes === 1);

  // resize by the bottom-right corner, then rotate
  await cdp.drag(await at(cdp, tree.cx + tree.w / 2, tree.cy + tree.h / 2), await at(cdp, tree.cx + tree.w / 2 + 96, tree.cy + tree.h / 2 + 128));
  s = await state(cdp);
  const big = find(s, "image", 1);
  check("corner handle resizes and keeps the aspect ratio", big.w > tree.w + 60 && near(big.w / big.h, tree.w / tree.h, 0.01), [big.w, big.h]);
  check("the opposite corner stays anchored", near(big.cx - big.w / 2, tree.cx - tree.w / 2, 1) && near(big.cy - big.h / 2, tree.cy - tree.h / 2, 1));
  const handle = await cdp.eval(`(() => { const ws = ${WS}, h = ws.handles(ws.single())[4].pos, r = ws.cv.getBoundingClientRect(), k = r.width / ws.cv.clientWidth; return [r.left + h[0] * k, r.top + h[1] * k]; })()`);
  await cdp.drag(handle, [handle[0] + 120, handle[1] + 60]);
  s = await state(cdp);
  check("rotate handle rotates", Math.abs(find(s, "image", 1).rot) > 0.2, find(s, "image", 1).rot);
  await cdp.key("z", CTRL);
  s = await state(cdp);
  check("Ctrl+Z undoes the rotation", find(s, "image", 1).rot === 0 && s.future === 1);
  await cdp.key("z", CTRL | SHIFT);
  s = await state(cdp);
  check("Ctrl+Shift+Z redoes it", Math.abs(find(s, "image", 1).rot) > 0.2 && s.future === 0);
  await cdp.key("z", CTRL);

  // pen
  await cdp.key("b");
  await cdp.drag(await at(cdp, 150, 950), await at(cdp, 900, 930));
  await cdp.drag(await at(cdp, 160, 960), await at(cdp, 500, 880));
  await cdp.drag(await at(cdp, 80, 90), await at(cdp, 160, 150));
  s = await state(cdp);
  const hill = find(s, "sketch", 1), sun = find(s, "sketch", 2);
  check("nearby strokes merge into one sketch, distant ones start a new one", s.tool === "pen" && hill?.strokes === 2 && sun?.strokes === 1, [hill?.strokes, sun?.strokes]);
  check("sketch bounds follow the strokes", hill && near(hill.cx, 525, 30) && hill.w > 700 && near(sun.cx, 120, 12), [hill?.cx, hill?.w, sun?.cx]);

  // eraser
  await cdp.key("e");
  await cdp.drag(await at(cdp, 150, 60), await at(cdp, 90, 180));
  s = await state(cdp);
  check("eraser removes the stroke it crosses", !find(s, "sketch", 2) && find(s, "sketch", 1)?.strokes === 2);
  await cdp.key("z", CTRL);
  s = await state(cdp);
  check("undo brings the erased sketch back", !!find(s, "sketch", 2));

  // notes: tool, context menu, edit
  await cdp.key("n");
  await cdp.click(await at(cdp, 480, 500));
  s = await state(cdp);
  check("note tool opens a focused editor", s.editor && (await cdp.eval("document.activeElement.classList.contains('gapc-edit')")));
  await cdp.type("girl climbing tree from this side");
  await cdp.key("Enter");
  s = await state(cdp);
  check("Enter saves the note", find(s, "note", 1)?.text === "girl climbing tree from this side" && !s.editor);
  check("typing never leaks into the graph", s.nodes === 1 && s.tool === "note");

  const spot = await at(cdp, 120, 120);
  await cdp.mouse("mousePressed", spot[0], spot[1], { button: "right", buttons: 2 });
  await cdp.mouse("mouseReleased", spot[0], spot[1], { button: "right", buttons: 0 });
  await sleep(250);
  const menus = await cdp.eval(`({ own: [...document.querySelectorAll(".gapc-menu button")].map((b) => b.firstChild.textContent), comfy: document.querySelectorAll(".litecontextmenu, .p-contextmenu, .p-tieredmenu").length })`);
  check("right-click opens the canvas menu, not the graph menu", menus.own[0] === "Add note here" && menus.own.includes("Use as reference only") && menus.comfy === 0, menus);
  await cdp.eval(`document.querySelector(".gapc-menu button").click()`);
  await sleep(150);
  await cdp.type("sun location here, sunset");
  await cdp.key("Enter");
  s = await state(cdp);
  check("context-menu note is saved", find(s, "note", 2)?.text === "sun location here, sunset");

  await cdp.key("v");
  const pin = await at(cdp, find(s, "note", 2).x, find(s, "note", 2).y);
  await cdp.click(pin, { clickCount: 1 });
  await cdp.click(pin, { clickCount: 2 });
  await sleep(150);
  check("double-click reopens a note", (await state(cdp)).editor);
  await cdp.key("a", CTRL);
  await cdp.type("sun here, sunset light");
  await cdp.key("Enter");
  s = await state(cdp);
  check("edited note text is stored", find(s, "note", 2)?.text === "sun here, sunset light", find(s, "note", 2)?.text);
  await cdp.waitFor(`${WS}.compiled.prompt.includes("sun here, sunset light")`, 5000).catch(() => {});
  s = await state(cdp);
  check("the compiled prompt links the notes to what they point at", /Picture \d/.test(s.compiled.prompt) && /girl climbing tree from this side/i.test(s.compiled.prompt) && /hand-drawn sketch[^\n]*: sun here, sunset light/i.test(s.compiled.prompt), s.compiled.prompt);

  // wheel: the graph's until the workspace has focus, then the workspace's
  const centre = await at(cdp, 512, 512);
  await cdp.eval(`document.activeElement.blur()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: centre[0], y: centre[1], deltaX: 0, deltaY: -120 });
  await sleep(300);
  let z = await state(cdp);
  // the classic renderer only forwards a plain wheel to the graph in legacy navigation mode, so the graph side is checked for Nodes 2.0
  check("wheel over an unfocused workspace is left to the graph", z.view.z === s.view.z && (!vue || z.graph[0] !== s.graph[0]), [s.graph[0], z.graph[0]]);
  await cdp.eval(`(() => { app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, -210]; app.canvas.setDirty(true, true); ${WS}.root.focus(); })()`);
  await sleep(500);
  s = await state(cdp);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: centre[0], y: centre[1], deltaX: 0, deltaY: -240 });
  await sleep(200);
  z = await state(cdp);
  const centreAfter = await at(cdp, 512, 512);
  check("wheel zooms the workspace around the cursor", z.view.z > s.view.z * 1.2 && near(centreAfter[0], centre[0], 2) && near(centreAfter[1], centre[1], 2), [s.view.z, z.view.z]);
  check("wheel does not zoom the graph", z.graph.join() === s.graph.join());
  await cdp.eval(`${WS}.root.focus()`);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
  await cdp.drag(centre, [centre[0] + 60, centre[1] + 30]);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  const panned = await state(cdp);
  check("Space-drag pans", near(panned.view.x - z.view.x, 60, 3) && near(panned.view.y - z.view.y, 30, 3) && panned.items.length === z.items.length);
  check("releasing Space ends pan mode", (await cdp.eval(`${WS}.space`)) === false);
  await cdp.key("f");

  // paste and drop
  const grown = await cdp.eval(`(async () => {
    const ws = ${WS};
    const c = document.createElement("canvas"); c.width = 300; c.height = 300; c.getContext("2d").fillRect(0, 0, 300, 300);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const data = new DataTransfer(); data.items.add(new File([blob], "gapc_e2e_paste.png", { type: "image/png" }));
    ws.root.focus();
    ws.root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    const drop = new DataTransfer(); drop.items.add(new File([blob], "gapc_e2e_drop.png", { type: "image/png" }));
    const r = ws.cv.getBoundingClientRect();
    ws.cv.dispatchEvent(new DragEvent("drop", { dataTransfer: drop, bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 30 }));
    for (let i = 0; i < 50 && ws.items("image").length < 4; i++) await new Promise((r) => setTimeout(r, 100));
    await Promise.all([...ws.pending]);
    await new Promise((r) => setTimeout(r, 200));
    return { images: ws.items("image").length, nodes: app.graph._nodes.length, files: ws.items("image").every((i) => i.file) };
  })()`);
  check("pasted and dropped images are added without creating graph nodes", grown.images === 4 && grown.nodes === 1 && grown.files, grown);

  // delete key removes the selection, never the node
  await cdp.key("v");
  await cdp.eval(`(() => { const ws = ${WS}; ws.change(() => Object.assign(ws.items("image").find((i) => i.n === 4), { cx: 1500, cy: 200 })); ws.fit(); })()`);
  await sleep(200);
  await cdp.click(await at(cdp, 1500, 200));
  await cdp.key("Delete");
  s = await state(cdp);
  check("Delete removes the selected item only", !find(s, "image", 4) && s.nodes === 1 && s.items.length === 7, s.items.length);
  await cdp.eval(`(() => { const ws = ${WS}; ws.sel = new Set([ws.items("image").find((i) => i.n === 3).id]); ws.removeSelected(); ws.fit(); })()`);

  // model, ratio and base image
  await cdp.eval(`(() => { const sel = ${WS}.modelSelect; sel.value = "flux2"; sel.dispatchEvent(new Event("change")); })()`);
  await cdp.waitFor(`${WS}.compiled.slots[0]?.token === "image 1"`, 5000);
  check("switching the model renames the references", true);
  await cdp.eval(`(() => { const sel = ${WS}.ratioSelect; sel.value = "16:9"; sel.dispatchEvent(new Event("change")); })()`);
  s = await state(cdp);
  check("16:9 at 1 MP gives a 1360x768 frame", s.frame.w === 1360 && s.frame.h === 768, s.frame);
  await cdp.eval(`(() => { const sel = ${WS}.modelSelect; sel.value = "qwen_edit"; sel.dispatchEvent(new Event("change")); })()`);

  // a zoomed-out graph must not break pointer mapping
  await cdp.eval(`(() => { app.canvas.ds.scale = 0.7; app.canvas.ds.offset = [60, -120]; app.canvas.setDirty(true, true); })()`);
  await sleep(700);
  s = await state(cdp);
  const girl = find(s, "image", 2);
  await cdp.drag(await at(cdp, girl.cx, girl.cy), await at(cdp, girl.cx + 90, girl.cy - 40));
  const moved = find(await state(cdp), "image", 2);
  check("pointer mapping holds when the graph is zoomed", near(moved.cx - girl.cx, 90, 6) && near(moved.cy - girl.cy, -40, 6), [moved.cx - girl.cx, moved.cy - girl.cy]);
  await cdp.eval(`(() => { app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, -210]; app.canvas.setDirty(true, true); })()`);
  await sleep(500);

  // maximize
  await cdp.eval(`${WS}.maxButton.click()`);
  await sleep(400);
  const max = await cdp.eval(`(() => { const r = ${WS}.root.getBoundingClientRect(); return { body: ${WS}.root.parentElement === document.body, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; })()`);
  check("maximize fills the window", max.body && near(max.w, max.vw, 2) && near(max.h, max.vh, 2), max);
  await cdp.screenshot(`${vue ? "vue" : "classic"}-maximized.png`);
  s = await state(cdp);
  const girlMax = find(s, "image", 2);
  await cdp.drag(await at(cdp, girlMax.cx, girlMax.cy), await at(cdp, girlMax.cx - 90, girlMax.cy + 40));
  check("editing works while maximized", near(find(await state(cdp), "image", 2).cx, girlMax.cx - 90, 6));
  await cdp.eval(`${WS}.sel.clear(); ${WS}.root.focus()`);
  await cdp.key("Escape");
  await sleep(400);
  check("Esc restores the node", await cdp.eval(`${WS}.root.parentElement === ${WS}.host && document.body.contains(${WS}.host)`));

  // save / load round trip
  await cdp.eval(`window.gapNode.widgets.find((w) => w.name === "prompt").value = "golden hour, @image1 on a hill"`);
  await cdp.screenshot(`${vue ? "vue" : "classic"}-node.png`);
  const round = await cdp.eval(`(async () => {
    const before = JSON.stringify(${WS}.scene);
    const size = [...window.gapNode.size];
    const data = JSON.parse(JSON.stringify(app.graph.serialize()));
    await app.loadGraphData(data);
    await new Promise((r) => setTimeout(r, 1200));
    window.gapNode = app.graph._nodes.find((n) => n.comfyClass === "GeekatplayCanvas");
    const saved = data.nodes[0].widgets_values;
    return { same: JSON.stringify(${WS}.scene) === before, prompt: window.gapNode.widgets.find((w) => w.name === "prompt").value,
      saved: saved.length, kinds: saved.map((v) => typeof v), size, sizeAfter: [...window.gapNode.size] };
  })()`);
  check("workflow save and load keeps the scene and the prompt", round.same && round.prompt === "golden hour, @image1 on a hill" && round.saved === 2, round);
  check("node size survives the round trip", near(round.size[0], round.sizeAfter[0], 2) && near(round.size[1], round.sizeAfter[1], 40), [round.size, round.sizeAfter]);

  // queue: renders are uploaded and the backend runs the node
  const queued = await cdp.eval(`(async () => {
    await new Promise((r) => setTimeout(r, 600));
    const { output } = await app.graphToPrompt();
    const id = String(window.gapNode.id);
    const scene = JSON.parse(output[id].inputs.scene);
    const probe = async (name) => {
      const r = await fetch("/view?type=input&subfolder=geekatplay_canvas&filename=" + encodeURIComponent(name));
      if (!r.ok) return null;
      const bmp = await createImageBitmap(await r.blob());
      return [bmp.width, bmp.height];
    };
    output["9001"] = { class_type: "PreviewImage", inputs: { images: [id, 1] } };
    output["9002"] = { class_type: "PreviewImage", inputs: { images: [id, 2] } };
    output["9003"] = { class_type: "PreviewImage", inputs: { images: [id, 3] } };
    output["9004"] = { class_type: "PreviewAny", inputs: { source: [id, 0] } };
    const response = await fetch("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: output }) });
    const body = await response.json();
    let history = null;
    for (let i = 0; i < 150 && !history; i++) {
      await new Promise((r) => setTimeout(r, 200));
      history = (await (await fetch("/history/" + body.prompt_id)).json())[body.prompt_id];
    }
    return { renders: scene.renders, frame: scene.frame, layout: await probe(scene.renders.layout), annotated: await probe(scene.renders.annotated),
      queued: response.status, error: body.error || body.node_errors, status: history?.status?.status_str,
      outputs: history ? Object.fromEntries(Object.entries(history.outputs).map(([k, v]) => [k, v.images ? v.images.length : JSON.stringify(v).slice(0, 4000)])) : null,
      messages: history?.status?.messages?.filter((m) => m[0].includes("error")) };
  })()`);
  check("queueing uploads frame renders at the frame size", queued.layout?.join() === [queued.frame.w, queued.frame.h].join() && queued.annotated?.join() === queued.layout?.join(), [queued.layout, queued.renders]);
  check("the backend executes the node", queued.queued === 200 && queued.status === "success" && queued.outputs?.["9001"] === 1 && queued.outputs?.["9002"] === 1 && queued.outputs?.["9003"] === 1, queued);
  check("the prompt output names the model's images", /Picture 1 is only a rough sketch of the arrangement/.test(String(queued.outputs?.["9004"])) && String(queued.outputs?.["9004"]).includes("golden hour, "), queued.outputs?.["9004"]);
}

const profile = path.join(os.tmpdir(), `gapc-e2e-chrome-${Date.now()}`);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1600,1100", "--no-first-run", "about:blank"], { stdio: "ignore" });
let failed = true;
const original = await (await fetch(`${BASE}/api/settings/Comfy.VueNodes.Enabled`)).json().catch(() => null);
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).then((list) => list.find((t) => t.type === "page")).catch(() => null);
  }
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  for (const vue of [true, false]) {
    try {
      await run(cdp, vue);
    } catch (error) {
      check("run completed", false, error.message);
      await cdp.screenshot(`${vue ? "vue" : "classic"}-failure.png`).catch(() => {});
    }
  }
  mode = "all";
  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 600));
  failed = results.some((r) => !r.ok);
} finally {
  if (typeof original === "boolean") {
    await fetch(`${BASE}/api/settings/Comfy.VueNodes.Enabled`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(original) });
  }
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
