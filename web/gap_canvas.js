import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { Workspace } from "./workspace.js";

const SUBFOLDER = "geekatplay_canvas";

const style = document.createElement("link");
style.rel = "stylesheet";
style.href = new URL("./workspace.css", import.meta.url).href;
document.head.append(style);

const profiles = api.fetchApi("/geekatplay_canvas/profiles").then((r) => r.json());

async function upload(blob, name, overwrite) {
  const body = new FormData();
  body.append("image", blob, name);
  body.append("subfolder", SUBFOLDER);
  body.append("type", "input");
  if (overwrite) body.append("overwrite", "true");
  const response = await api.fetchApi("/upload/image", { method: "POST", body });
  if (response.status !== 200) throw new Error(`Geekatplay Canvas: upload of ${name} failed (${response.status})`);
  return response.json();
}

app.registerExtension({
  name: "Geekatplay.Canvas",
  nodeCreated(node) {
    // a saved workflow overrides this with its own size when it is configured
    if (node.comfyClass === "GeekatplayCanvas") node.setSize([900, 980]);
  },
  async getCustomWidgets() {
    const { profiles: list, default: defaultModel } = await profiles;
    return {
      GAP_CANVAS(node, inputName) {
        const host = document.createElement("div");
        host.className = "gapc-host";
        const promptText = () => node.widgets?.find((w) => w.name === "prompt")?.value || "";
        const workspace = new Workspace(host, {
          profiles: list,
          defaultModel,
          uploadImage: async (file) => {
            const { name, subfolder, type } = await upload(file, file.name, false);
            return { name, subfolder, type };
          },
          uploadRender: (blob, name) => upload(blob, name, true),
          viewUrl: (file) => api.apiURL(`/view?filename=${encodeURIComponent(file.name)}&subfolder=${encodeURIComponent(file.subfolder || "")}&type=${file.type || "input"}`),
          compile: (scene) => api.fetchApi("/geekatplay_canvas/compile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scene, prompt: promptText() }),
          }).then((r) => r.json()),
          onChange: () => node.graph?.setDirtyCanvas(true, true),
        });
        const widget = node.addDOMWidget(inputName, "GAP_CANVAS", host, {
          getValue: () => JSON.stringify(workspace.getScene()),
          setValue: (value) => workspace.setScene(value),
          getMinHeight: () => 480,
          hideOnZoom: false,
        });
        widget.serializeValue = async () => JSON.stringify(await workspace.prepare());
        node.gapCanvas = workspace;

        // the prompt box feeds the compiled preview too
        queueMicrotask(() => {
          const prompt = node.widgets?.find((w) => w.name === "prompt");
          if (!prompt) return;
          const callback = prompt.callback;
          prompt.callback = function (...args) {
            workspace.refreshCompile();
            return callback?.apply(this, args);
          };
        });
        const removed = node.onRemoved;
        node.onRemoved = function (...args) {
          workspace.destroy();
          return removed?.apply(this, args);
        };
        return { widget };
      },
    };
  },
});
