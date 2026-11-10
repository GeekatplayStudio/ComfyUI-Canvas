"""Geekatplay Canvas - a reference workspace node for ComfyUI (Geekatplay Studio / Vladimir Chopine)."""

from aiohttp import web
from server import PromptServer

from . import compiler, profiles
from .canvas_node import CanvasExtension

WEB_DIRECTORY = "./web"


@PromptServer.instance.routes.get("/geekatplay_canvas/profiles")
async def get_profiles(request):
    return web.json_response({"profiles": profiles.as_list(), "default": profiles.DEFAULT})


@PromptServer.instance.routes.post("/geekatplay_canvas/compile")
async def compile_preview(request):
    data = await request.json()
    compiled = compiler.compile_scene(data.get("scene") or {}, data.get("prompt", ""))
    return web.json_response({"prompt": compiled.prompt, "slots": compiled.slots, "warnings": compiled.warnings,
                              "brief": compiled.brief, "director": compiled.director})


async def comfy_entrypoint() -> CanvasExtension:
    return CanvasExtension()
