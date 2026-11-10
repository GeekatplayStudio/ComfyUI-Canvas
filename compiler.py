"""Turns a canvas scene (placed images, sketches, notes) into a prompt for one model profile.

Pure Python, no ComfyUI imports, so it runs in the unit tests as is.
"""

import json
import math
import re

from . import profiles

POSITIONS = (("top-left", "top-center", "top-right"),
             ("center-left", "center", "center-right"),
             ("bottom-left", "bottom-center", "bottom-right"))
MENTION = re.compile(r"@(image|sketch)\s?(\d+)", re.IGNORECASE)


def parse_scene(scene):
    if isinstance(scene, str):
        scene = json.loads(scene) if scene.strip() else {}
    frame = scene.get("frame") or {}
    return {
        "model": scene.get("model", profiles.DEFAULT),
        "layout": scene.get("layout", "auto"),
        "w": int(frame.get("w", 1024)),
        "h": int(frame.get("h", 1024)),
        "items": scene.get("items") or [],
        "renders": scene.get("renders") or {},
    }


def aabb(item):
    c, s = abs(math.cos(item.get("rot", 0))), abs(math.sin(item.get("rot", 0)))
    hw = (item["w"] * c + item["h"] * s) / 2
    hh = (item["w"] * s + item["h"] * c) / 2
    return item["cx"] - hw, item["cy"] - hh, item["cx"] + hw, item["cy"] + hh


def is_placed(item, w, h):
    """Placed items are part of the picture; the rest are references only."""
    return not item.get("refOnly") and 0 <= item["cx"] <= w and 0 <= item["cy"] <= h


def position(x, y, w, h):
    col = min(2, max(0, int(3 * x / w)))
    row = min(2, max(0, int(3 * y / h)))
    return POSITIONS[row][col]


def side_of(x, y, box):
    """Which side of a box the point is on, in words."""
    x0, y0, x1, y1 = box
    dx = (x - (x0 + x1) / 2) / max(1.0, (x1 - x0) / 2)
    dy = (y - (y0 + y1) / 2) / max(1.0, (y1 - y0) / 2)
    if max(abs(dx), abs(dy)) < 0.34:
        return ""
    if abs(dx) >= abs(dy):
        return "right" if dx > 0 else "left"
    return "bottom" if dy > 0 else "top"


def contains(item, x, y):
    lx, ly = x - item["cx"], y - item["cy"]
    c, s = math.cos(-item.get("rot", 0)), math.sin(-item.get("rot", 0))
    return abs(lx * c - ly * s) <= item["w"] / 2 and abs(lx * s + ly * c) <= item["h"] / 2


def box_distance(x, y, box):
    x0, y0, x1, y1 = box
    return math.hypot(max(x0 - x, 0, x - x1), max(y0 - y, 0, y - y1))


def bbox_1000(item, w, h):
    """[ymin, xmin, ymax, xmax] on a 0-1000 grid, clipped to the frame."""
    x0, y0, x1, y1 = aabb(item)
    return [round(1000 * min(max(v / d, 0.0), 1.0)) for v, d in ((y0, h), (x0, w), (y1, h), (x1, w))]


class Compiled:
    def __init__(self):
        self.prompt = ""
        self.brief = ""
        self.director = ""
        self.slots = []        # [{"slot": 1, "kind": "layout"|"image"|"sketch", "id": ..., "token": ...}]
        self.warnings = []


def compile_scene(scene, prompt=""):
    sc = parse_scene(scene)
    profile = profiles.get(sc["model"])
    w, h = sc["w"], sc["h"]
    out = Compiled()

    things = [i for i in sc["items"] if i.get("type") in ("image", "sketch")]
    notes = sorted((i for i in sc["items"] if i.get("type") == "note" and i.get("text", "").strip()), key=lambda i: i["n"])
    placed = [i for i in things if is_placed(i, w, h)]
    placed_ids = {i["id"] for i in placed}

    use_layout = profile.max_images > 0 and bool(placed) and (sc["layout"] == "on" or (sc["layout"] == "auto" and profile.layout_guide))
    base = None
    if use_layout and len(placed) == 1 and placed[0]["type"] == "image" and abs(placed[0].get("rot", 0)) < 0.01:
        x0, y0, x1, y1 = aabb(placed[0])
        covered = max(0, min(x1, w) - max(x0, 0)) * max(0, min(y1, h) - max(y0, 0))
        if covered >= 0.9 * w * h:
            base = placed[0]

    # Sketches inside the picture are only visible through the layout; outside it they are their own reference image.
    refs = [i for i in things if i is not base and (i["type"] == "image" or i["id"] not in placed_ids)]
    refs.sort(key=lambda i: (i["type"] != "image", i["n"]))
    room = max(0, profile.max_images - (1 if use_layout else 0))
    dropped = []
    while len(refs) > room:
        # the layout still shows placed items, so those go first
        visible = [i for i in refs if use_layout and i["id"] in placed_ids]
        victim = (visible or refs)[-1]
        refs.remove(victim)
        dropped.append(victim)

    tokens = {}
    slot = profile.ref_base
    layout_token = ""
    if use_layout:
        layout_token = profile.ref.format(n=slot)
        out.slots.append({"slot": len(out.slots) + 1, "kind": "layout", "id": None, "token": layout_token})
        slot += 1
    for item in refs:
        tokens[item["id"]] = profile.ref.format(n=slot)
        out.slots.append({"slot": len(out.slots) + 1, "kind": item["type"], "id": item["id"], "token": tokens[item["id"]]})
        slot += 1
    if base is not None:
        tokens[base["id"]] = layout_token

    by_label = {(i["type"], i["n"]): i for i in things}
    # positions name the picture being made, never the guide image, or edit models copy the guide
    where = "picture" if use_layout and base is None else "frame"

    def label(item):
        return "@{}{}".format(item["type"], item["n"])

    def named(item):
        return " ({})".format(item["name"].strip()) if item.get("name", "").strip() else ""

    def describe(item):
        if item["id"] in tokens:
            return tokens[item["id"]] + named(item)
        name = item.get("name", "").strip() or ("hand-drawn sketch" if item["type"] == "sketch" else "element")
        # a named item needs no pointer for a model that reads text only
        if item["id"] in placed_ids and (use_layout or not item.get("name", "").strip()):
            return "the {} at the {} of the {}".format(name, position(item["cx"], item["cy"], w, h), where)
        return "the {}".format(name)

    def resolve(text):
        def swap(m):
            item = by_label.get((m.group(1).lower(), int(m.group(2))))
            return describe(item) if item else m.group(0)
        # "the @image2" would otherwise read "the the doll"
        return re.sub(r"\b(?:the|a|an) (the )", r"\1", MENTION.sub(swap, text.strip()), flags=re.IGNORECASE)

    for item in dropped:
        if item["id"] in placed_ids and use_layout:
            out.warnings.append("{} is only sent through the layout guide: {} takes {} images.".format(label(item), profile.label, profile.max_images))
        elif profile.max_images:
            out.warnings.append("{} is not sent: {} takes {} images.".format(label(item), profile.label, profile.max_images))
    if profile.max_images == 0 and any(i["type"] == "image" for i in things):
        out.warnings.append("{} cannot see reference images. Only names, positions and notes are used.".format(profile.label))

    # Each note is tied to the item under its pin, else to the nearest one.
    reach = 0.3 * math.hypot(w, h)
    instructions = []      # (item or None, note, sentence with a lead saying where, resolved text)
    for note in notes:
        x, y = note["x"], note["y"]
        text = resolve(note["text"])
        target = next((i for i in reversed(things) if contains(i, x, y)), None)
        inside = 0 <= x <= w and 0 <= y <= h
        if target is not None:
            side = side_of(x, y, aabb(target)) if min(target["w"], target["h"]) > 0.15 * min(w, h) else ""
            lead = "About {}{}".format(describe(target), ", at its {} side".format(side) if side else "")
        else:
            near = min(things, key=lambda i: box_distance(x, y, aabb(i)), default=None)
            if near is not None and box_distance(x, y, aabb(near)) <= reach:
                target = near
                side = side_of(x, y, aabb(near)) or "side"
                lead = "Next to {}, on its {}".format(describe(near), side if side == "side" else side + " side")
                if inside:
                    lead += " ({} of the {})".format(position(x, y, w, h), where)
            elif inside:
                lead = "At the {} of the {}".format(position(x, y, w, h), where)
            else:
                lead = ""
        instructions.append((target, note, "{}: {}".format(lead, text) if lead else text, text))

    prompt = resolve(prompt)
    captions = {}
    for target, _, _, text in instructions:
        if target is not None:
            captions.setdefault(target["id"], []).append(text)

    def caption(item):
        parts = ([item["name"].strip()] if item.get("name", "").strip() else []) + captions.get(item["id"], [])
        return "; ".join(parts)

    if profile.layout in ("moss", "ideogram"):
        free = [s for target, _, s, _ in instructions if target is None or target["id"] not in placed_ids]
        summary = " ".join([prompt] + [s.rstrip(".") + "." for s in free]).strip()
        boxed = [i for i in placed if caption(i)]
        for item in placed:
            if not caption(item):
                out.warnings.append("{} has no name or note, so it is left out of the layout.".format(label(item)))
        if not boxed:
            out.prompt = summary
        elif profile.layout == "moss":
            rows = []
            for item in boxed:
                x0, y0, x1, y1 = aabb(item)
                rows.append({"label": "object", "caption": caption(item),
                             "bbox": [math.floor(max(y0, 0)) - h // 2, math.floor(max(x0, 0)) - w // 2,
                                      math.ceil(min(y1, h)) - h // 2, math.ceil(min(x1, w)) - w // 2]})
            out.prompt = json.dumps({"summary": {"caption": summary}, "items": rows, "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"},
                                    ensure_ascii=False, separators=(",", ":"))
        else:
            rows = [{"type": "obj", "bbox": bbox_1000(i, w, h), "desc": caption(i)} for i in boxed]
            out.prompt = json.dumps({"high_level_description": summary, "compositional_deconstruction": {"background": "", "elements": rows}},
                                    ensure_ascii=False, separators=(",", ":"))
    else:
        def sentence(text):
            text = text[:1].upper() + text[1:]
            return text if text[-1:] in ".!?" else text + "."

        # A note goes into the sentence of the image it points at, without a side lead: told "next to X, on its
        # left side", edit models add a second copy of the subject there.
        folded = {}
        loose = []
        for target, note, _, text in instructions:
            if target is not None and target["id"] in tokens:
                folded.setdefault(target["id"], []).append(sentence(text))
            elif target is not None:
                spot = describe(target)
                loose.append("{}: {}".format(spot[0].upper() + spot[1:], sentence(text)))
            elif 0 <= note["x"] <= w and 0 <= note["y"] <= h:
                loose.append("At the {} of the {}: {}".format(position(note["x"], note["y"], w, h), where, sentence(text)))
            else:
                loose.append(sentence(text))

        def with_notes(item, line):
            return " ".join([line] + folded.get(item["id"], []))

        lines = []
        objects = {}
        if use_layout and base is not None:
            lines.append(with_notes(base, "{} is the base image. Keep its composition, framing and everything that is not mentioned below unchanged.".format(layout_token)))
        elif use_layout:
            # the goal comes first: told that the guide is "a collage to recreate", Qwen Edit keeps the collage
            if prompt:
                lines.append(prompt)
            lines.append("Create one single, seamless, full-frame image of a new scene. {} is only a rough sketch of the arrangement: use it for the positions and sizes of things, "
                         "but do not copy it, and do not show any pasted photo, white background, frame or drawn line from it.".format(layout_token))
        if profile.layout == "flux3":
            objects = {item["id"]: "<obj_{}>".format(n + 1) for n, item in enumerate(placed)}
        for item in refs:
            if item["id"] in placed_ids:
                subject = "The {} from {}".format(item["name"].strip(), tokens[item["id"]]) if item.get("name", "").strip() else "The subject of {}".format(tokens[item["id"]])
                spot = objects.get(item["id"]) or "the {} of the {}".format(position(item["cx"], item["cy"], w, h), where)
                line = "{} appears once, at {}. Keep its identity and details.".format(subject, spot)
            elif item["type"] == "sketch":
                line = "{} is a hand-drawn sketch used as a reference.".format(tokens[item["id"]] + named(item))
            else:
                line = "{} is a reference image.".format(tokens[item["id"]] + named(item))
            lines.append(with_notes(item, line))
        if profile.max_images == 0:
            for item in placed:
                if item.get("name", "").strip() and item["id"] not in captions:
                    lines.append("At the {} of the frame: {}.".format(position(item["cx"], item["cy"], w, h), item["name"].strip()))
        if prompt and not (use_layout and base is None):
            lines.append(prompt)
        lines += loose
        if profile.layout == "flux3" and objects:
            rows = [{"id": objects[i["id"]].strip("<>"), "bbox": bbox_1000(i, w, h), "desc": caption(i) or label(i)} for i in placed]
            lines.append(json.dumps(rows, ensure_ascii=False))
        out.prompt = "\n".join(lines)

    # Brief and system prompt for an optional LLM pass that rewrites the draft.
    brief = ["Target image model: {}".format(profile.label), "Output size: {}x{} pixels".format(w, h), ""]
    brief.append("Attached image 1 is a screenshot of the user's canvas: the frame of the final picture with the placed items, numbered pins for the notes and labels for the references.")
    if out.slots:
        brief.append("The image model itself receives these images, which follow the screenshot in the same order:")
        for s in out.slots:
            if s["kind"] == "layout":
                brief.append("- {}: {}".format(s["token"], "the base image" if base is not None else "the clean canvas layout (no pins or labels)"))
            else:
                item = next(i for i in things if i["id"] == s["id"])
                state = "placed at the {} of the frame".format(position(item["cx"], item["cy"], w, h)) if item["id"] in placed_ids else "reference only, not placed in the picture"
                brief.append("- {}: {} {}{}, {}".format(s["token"], "sketch" if item["type"] == "sketch" else "image", label(item), named(item), state))
    else:
        brief.append("The image model receives no images, only text.")
    if notes:
        brief += ["", "The user's notes, in pin order:"] + ["{}. {}".format(n + 1, s) for n, (_, _, s, _) in enumerate(instructions)]
    brief += ["", "The user's prompt: {}".format(prompt or "(none)"), "", "Draft prompt compiled from the canvas:", out.prompt]
    out.brief = "\n".join(brief)

    # The LLM only describes the result. The reference naming stays in the compiled prompt, which small local models get wrong.
    out.director = ("You are an art director. The user arranged reference images, hand-drawn sketches and pinned notes on a canvas. "
                    "The first image is a screenshot of that canvas, the others are the references. Read the brief, work out how every note, sketch and reference "
                    "relates to the others, and describe the single final picture the user wants in one paragraph of at most 120 words: "
                    "the subjects and what they look like in the references, what they are doing, where they are in the frame, the setting and the light. "
                    "Follow every instruction the user gave and do not invent new subjects. "
                    "Do not mention the canvas, pins, labels, sketches, picture numbers or image names. Output only the paragraph.")
    return out
