import os

import numpy as np
import torch
from PIL import Image, ImageOps
from typing_extensions import override

import folder_paths
import node_helpers
from comfy_api.latest import ComfyExtension, io

from . import compiler

SUBFOLDER = "geekatplay_canvas"
IMAGE_SLOTS = 8


def input_path(name, subfolder=SUBFOLDER):
    """Resolves a canvas file inside the input directory, refusing anything that escapes it."""
    root = os.path.abspath(folder_paths.get_input_directory())
    path = os.path.abspath(os.path.join(root, subfolder or "", name or ""))
    if os.path.commonpath((root, path)) != root or not os.path.isfile(path):
        raise FileNotFoundError("Geekatplay Canvas: '{}' is missing from the input folder. Open the workflow in the browser and queue it again.".format(name))
    return path


def load_image(name, subfolder=SUBFOLDER, flip=False):
    img = node_helpers.pillow(Image.open, input_path(name, subfolder))
    img = node_helpers.pillow(ImageOps.exif_transpose, img).convert("RGBA")
    flat = Image.new("RGB", img.size, (255, 255, 255))
    flat.paste(img, mask=img.getchannel("A"))
    if flip:
        flat = ImageOps.mirror(flat)
    return torch.from_numpy(np.asarray(flat).astype(np.float32) / 255.0)[None,]


class GeekatplayCanvas(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="GeekatplayCanvas",
            display_name="Geekatplay Canvas",
            category="Geekatplay Studio/Canvas",
            description="A workspace for arranging reference images, sketches and pinned notes. It compiles them into a prompt and ordered reference images for the selected image model.",
            inputs=[
                io.Custom("GAP_CANVAS").Input("scene", extra_dict={"socketless": True}),
                io.String.Input("prompt", multiline=True, dynamic_prompts=True, default="",
                                tooltip="Overall description of the picture. Mention canvas items as @image1, @sketch1."),
            ],
            outputs=[
                io.String.Output(display_name="prompt", tooltip="Prompt compiled for the selected model. It names the images in the order of the image outputs."),
                io.Image.Output(display_name="annotated", tooltip="The frame with pins and labels, for previews and for an LLM that rewrites the prompt."),
                *[io.Image.Output(display_name="image_{}".format(n + 1), tooltip="Input image {} for the model. Empty when the canvas has fewer images.".format(n + 1)) for n in range(IMAGE_SLOTS)],
                io.Int.Output(display_name="width"),
                io.Int.Output(display_name="height"),
                io.String.Output(display_name="brief", tooltip="Canvas description for an LLM: the items, the notes and the compiled prompt."),
                io.String.Output(display_name="director", tooltip="System prompt for an LLM that reads the brief and describes the final picture. Append its answer to the prompt."),
            ],
        )

    @classmethod
    def execute(cls, scene, prompt) -> io.NodeOutput:
        sc = compiler.parse_scene(scene)
        compiled = compiler.compile_scene(scene, prompt)
        renders = sc["renders"]
        items = {i["id"]: i for i in sc["items"]}

        images = []
        for slot in compiled.slots:
            if slot["kind"] == "layout":
                images.append(load_image(renders.get("layout")))
            elif slot["kind"] == "sketch":
                images.append(load_image(renders.get("sketches", {}).get(slot["id"])))
            else:
                item = items[slot["id"]]
                images.append(load_image(item["file"]["name"], item["file"].get("subfolder", ""), item.get("flip", False)))
        images += [None] * (IMAGE_SLOTS - len(images))

        if renders.get("annotated"):
            annotated = load_image(renders["annotated"])
        else:
            annotated = torch.ones((1, sc["h"], sc["w"], 3))
        return io.NodeOutput(compiled.prompt, annotated, *images, sc["w"], sc["h"], compiled.brief, compiled.director)


class CanvasExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [GeekatplayCanvas]
