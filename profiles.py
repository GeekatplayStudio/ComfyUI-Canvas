"""Image model profiles for the Geekatplay Canvas prompt compiler.

A profile says how a model family is addressed: how many images it takes, how
the prompt names them, and whether it reads a layout table instead of prose.
"""

from dataclasses import dataclass, asdict


@dataclass(frozen=True)
class Profile:
    key: str
    label: str
    kind: str                 # "local" or "api"
    max_images: int           # image inputs the model's encoder node takes, 0 = text only
    ref: str = "image {n}"    # how the prompt names input image n
    ref_base: int = 1
    layout: str = "prose"     # prose | moss | flux3 | ideogram
    layout_guide: bool = True  # "auto" sends the canvas layout as the first image
    nodes: str = ""           # native nodes the outputs plug into
    note: str = ""


# The canvas node has 8 image outputs, so max_images is capped there.
PROFILES = [
    Profile("qwen_edit", "Qwen Image Edit 2511 / 2509", "local", 3, ref="Picture {n}",
            nodes="TextEncodeQwenImageEditPlus",
            note="Up to 3 images. Best all-rounder for combining references on a 24 GB card."),
    Profile("qwen_image_21", "Qwen Image 2.1 / 2.1 Turbo", "local", 8,
            nodes="TextEncodeQwenImage21",
            note="Text-to-image and multi-reference edit in one model."),
    Profile("flux2", "FLUX.2 Klein / Dev", "local", 8,
            nodes="ReferenceMultiLatent + CLIPTextEncode",
            note="Klein works best with up to 4 references, Dev with up to 8."),
    Profile("flux3", "FLUX 3 Klein", "local", 8, ref="<ref_image_{n}>", ref_base=0, layout="flux3", layout_guide=False,
            nodes="ReferenceMultiLatent + CLIPTextEncode",
            note="Placements are sent as a <obj_N> bounding-box table."),
    Profile("moss_edit", "MOSS-Image Edit (edit LoRA)", "local", 8, ref="Picture {n}",
            nodes="TextEncodeMOSSImageEdit",
            note="Needs the MOSS-Image edit LoRA."),
    Profile("moss_layout", "MOSS-Image layout (text to image)", "local", 0, layout="moss",
            nodes="CLIPTextEncode",
            note="No reference images: placements and notes become a JSON layout prompt."),
    Profile("ideogram4", "Ideogram 4 JSON (text to image)", "local", 0, layout="ideogram",
            nodes="CLIPTextEncode",
            note="No reference images: placements and notes become a JSON prompt."),
    Profile("text_only", "Any text-to-image model (Z-Image, Krea 2, ...)", "local", 0,
            nodes="CLIPTextEncode",
            note="No reference images: notes become a composition description."),
    Profile("nano_banana", "Nano Banana 2.1 / Pro (Gemini)", "api", 8,
            nodes="GeminiNanoBanana2V2",
            note="Partner API node, uses credits."),
    Profile("gpt_image", "OpenAI GPT Image 2.6", "api", 8,
            nodes="OpenAIGPTImageNodeV2",
            note="Partner API node, uses credits."),
    Profile("seedream", "Seedream 4.5 / 5.0", "api", 8,
            nodes="ByteDanceSeedreamNodeV3",
            note="Partner API node, uses credits."),
    Profile("qwen_api", "Qwen Image 3 Edit", "api", 3, ref="@Image{n}",
            nodes="QwenImageEditApi",
            note="Partner API node, uses credits. Up to 3 images."),
    Profile("generic", "Generic (@image1 tags)", "local", 8, ref="@image{n}",
            note="For any other multi-reference model."),
]

BY_KEY = {p.key: p for p in PROFILES}
DEFAULT = "qwen_edit"


def get(key):
    return BY_KEY.get(key) or BY_KEY[DEFAULT]


def as_list():
    return [asdict(p) for p in PROFILES]
