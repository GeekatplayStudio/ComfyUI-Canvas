"""Run from the pack folder: python -m unittest discover -s tests"""

import importlib.util
import json
import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pkg = types.ModuleType("gapcanvas")
pkg.__path__ = [ROOT]
sys.modules["gapcanvas"] = pkg
for name in ("profiles", "compiler"):
    spec = importlib.util.spec_from_file_location("gapcanvas." + name, os.path.join(ROOT, name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
compiler = sys.modules["gapcanvas.compiler"]
profiles = sys.modules["gapcanvas.profiles"]


def image(n, cx, cy, w=300, h=300, **extra):
    return {"id": "i%d" % n, "type": "image", "n": n, "cx": cx, "cy": cy, "w": w, "h": h, "rot": 0,
            "file": {"name": "img%d.png" % n, "subfolder": "geekatplay_canvas", "type": "input"}, **extra}


def sketch(n, cx, cy, w=200, h=100, **extra):
    return {"id": "s%d" % n, "type": "sketch", "n": n, "cx": cx, "cy": cy, "w": w, "h": h, "rot": 0, "strokes": [], **extra}


def note(n, x, y, text):
    return {"id": "n%d" % n, "type": "note", "n": n, "x": x, "y": y, "text": text}


def scene(model, items, w=1360, h=768, layout="auto"):
    return {"model": model, "layout": layout, "frame": {"w": w, "h": h}, "items": items}


# tree on the right, girl on the left, a hill drawn under the tree, a sun drawn behind
TREE_SCENE = [
    image(1, 1000, 380, 400, 500, name="tree"),
    image(2, 300, 450, 200, 300),
    sketch(1, 900, 700, 600, 120),
    sketch(2, 1200, 120, 120, 120),
    note(1, 640, 400, "girl climbing tree from this side"),
    note(2, 900, 710, "tree located on the hill"),
    note(3, 1210, 110, "sun location here, sunset"),
]


class CompilerTest(unittest.TestCase):
    def test_tree_scene_qwen_edit(self):
        out = compiler.compile_scene(scene("qwen_edit", TREE_SCENE), "golden hour photo")
        self.assertEqual([s["kind"] for s in out.slots], ["layout", "image", "image"])
        self.assertEqual([s["token"] for s in out.slots], ["Picture 1", "Picture 2", "Picture 3"])
        self.assertTrue(out.prompt.startswith("golden hour photo\nCreate one single, seamless, full-frame image"))
        self.assertIn("Picture 1 is only a rough sketch of the arrangement", out.prompt)
        self.assertIn("The tree from Picture 2 appears once, at the center-right of the picture", out.prompt)
        # notes join the sentence of the image they point at, with no "on its left side" lead
        self.assertIn("The tree from Picture 2 appears once, at the center-right of the picture. Keep its identity and details. Girl climbing tree from this side.", out.prompt)
        self.assertIn("The hand-drawn sketch at the bottom-center of the picture: Tree located on the hill.", out.prompt)
        self.assertNotIn("side (", out.prompt)
        named = compiler.compile_scene(scene("moss_layout", TREE_SCENE + [note(4, 310, 460, "the @image1 is behind her")]))
        self.assertIn("the tree is behind her", named.prompt)
        self.assertNotIn("the the", named.prompt)
        self.assertIn("The hand-drawn sketch at the top-right of the picture: Sun location here, sunset.", out.prompt)
        self.assertIn("golden hour photo", out.prompt)
        self.assertEqual(out.warnings, [])

    def test_dress_edit_uses_base_image_and_shelf(self):
        items = [image(1, 512, 512, 1024, 1024), image(2, 1400, 300), sketch(1, 1400, 800),
                 note(1, 1400, 320, "dress this woman in this suit"), note(2, 1410, 800, "make her hair look like this")]
        out = compiler.compile_scene(scene("qwen_edit", items, 1024, 1024))
        self.assertEqual([(s["kind"], s["id"]) for s in out.slots], [("layout", None), ("image", "i2"), ("sketch", "s1")])
        self.assertIn("Picture 1 is the base image", out.prompt)
        self.assertIn("Picture 2 is a reference image.", out.prompt)
        self.assertIn("Picture 3 is a hand-drawn sketch used as a reference.", out.prompt)
        self.assertIn("Picture 2 is a reference image. Dress this woman in this suit.", out.prompt)
        self.assertIn("Picture 3 is a hand-drawn sketch used as a reference. Make her hair look like this.", out.prompt)

    def test_mentions_are_renamed_per_model(self):
        items = [image(1, 512, 512, 1024, 1024), image(4, 1500, 200)]
        for model, expected in (("qwen_edit", "Put Picture 2 on Picture 1"), ("flux2", "Put image 2 on image 1"),
                                ("qwen_api", "Put @Image2 on @Image1"), ("generic", "Put @image2 on @image1")):
            out = compiler.compile_scene(scene(model, items, 1024, 1024), "Put @image4 on @Image 1")
            self.assertIn(expected, out.prompt, model)

    def test_overflow_drops_placed_items_first(self):
        items = [image(1, 300, 300), image(2, 800, 300), image(3, 1700, 300), image(4, 1700, 700)]
        out = compiler.compile_scene(scene("qwen_edit", items))
        self.assertEqual([s["id"] for s in out.slots], [None, "i3", "i4"])
        self.assertEqual(len(out.warnings), 2)
        self.assertIn("@image2 is only sent through the layout guide", out.warnings[0])

    def test_layout_off_and_no_placed_items(self):
        out = compiler.compile_scene(scene("flux2", [image(1, 300, 300), image(2, 800, 300)], layout="off"))
        self.assertEqual([s["token"] for s in out.slots], ["image 1", "image 2"])
        out = compiler.compile_scene(scene("flux2", [image(1, 2000, 300)]))
        self.assertEqual([s["kind"] for s in out.slots], ["image"])

    def test_moss_layout_json(self):
        out = compiler.compile_scene(scene("moss_layout", TREE_SCENE), "a quiet evening")
        data = json.loads(out.prompt)
        self.assertEqual(data["bbox_coord_space"], "abs_centralized")
        self.assertEqual(out.slots, [])
        captions = [i["caption"] for i in data["items"]]
        self.assertIn("tree; girl climbing tree from this side", captions)
        self.assertIn("sun location here, sunset", captions)
        for item in data["items"]:
            y0, x0, y1, x1 = item["bbox"]
            self.assertTrue(-384 <= y0 < y1 <= 384 and -680 <= x0 < x1 <= 680)
        self.assertTrue(any("cannot see reference images" in w for w in out.warnings))

    def test_ideogram_and_flux3_tables(self):
        data = json.loads(compiler.compile_scene(scene("ideogram4", TREE_SCENE), "poster").prompt)
        self.assertEqual(data["high_level_description"], "poster")
        for el in data["compositional_deconstruction"]["elements"]:
            self.assertTrue(all(0 <= v <= 1000 for v in el["bbox"]))
        out = compiler.compile_scene(scene("flux3", TREE_SCENE))
        self.assertEqual(out.slots[0]["token"], "<ref_image_0>")
        self.assertIn("The tree from <ref_image_0> appears once, at <obj_1>.", out.prompt)
        rows = json.loads(out.prompt.splitlines()[-1])
        self.assertEqual([r["id"] for r in rows], ["obj_1", "obj_2", "obj_3", "obj_4"])

    def test_text_only_and_empty(self):
        out = compiler.compile_scene(scene("text_only", [note(1, 100, 100, "a red kite")]), "a beach")
        self.assertEqual(out.prompt, "a beach\nAt the top-left of the frame: A red kite.")
        out = compiler.compile_scene("", "just text")
        self.assertEqual((out.prompt, out.slots), ("just text", []))
        self.assertIn("Draft prompt", out.brief)
        self.assertIn("Output only the paragraph", out.director)

    def test_every_profile_compiles(self):
        for p in profiles.PROFILES:
            out = compiler.compile_scene(scene(p.key, TREE_SCENE), "x @image1 @sketch2 @image9")
            self.assertLessEqual(len(out.slots), p.max_images)
            self.assertTrue(out.prompt and out.brief and out.director)


if __name__ == "__main__":
    unittest.main()
