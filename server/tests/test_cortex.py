r"""Tests for formulas, database settings, importers and the version diff.

Run:  server\.venv\Scripts\python -m unittest discover -s server\tests -v
Sample files are generated here; nothing is downloaded.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import struct
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import zipfile
import zlib
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import bases  # noqa: E402
import docx_import  # noqa: E402
import enex_import  # noqa: E402
import formula  # noqa: E402
import html_import  # noqa: E402
import markdown_import  # noqa: E402
import publish  # noqa: E402
import textdiff  # noqa: E402


def png(rgb=(200, 30, 30)) -> bytes:
    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes(rgb) * 8 for _ in range(8))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def make_zip(files: dict[str, bytes | str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


class FormulaTests(unittest.TestCase):
    NOW = datetime(2026, 10, 26, 12, 0, 0)
    PROPS = {"a": 6, "b": 4, "s": "hi", "d": date(2026, 10, 20), "n": None, "Due date": "2026-11-01", "tags": ["x", "y"], "t": True}

    def run_formula(self, src: str):
        def lookup(name):
            if name in self.PROPS:
                return self.PROPS[name]
            raise formula.FormulaError(f'unknown property "{name}"')
        return formula.run(src, formula.Context(lookup, self.NOW))

    def test_values(self):
        cases = {
            "a + b": 10, "a - b * 2": -2, "(a - b) * 2": 4, "a / b": 1.5, "a / 3": 2, "a % 4": 2, "2 * -3": -6,
            "a > b": True, "a == 6": True, "a != 6": False, '"a" < "b"': True, "a > 1 and b > 1": True, "not (a > 1)": False,
            'if(a > b, "big", "small")': "big", "if(a > 10, 1)": None, "if(true, 1, 1/0)": 1,
            'concat(s, "-", a, "!", t)': "hi-6!true", 's + " there"': "hi there", "n + 5": 5, 'concat("x", n, "y")': "xy",
            'dateDiff(now(), d)': 6.5, 'dateDiff(today(), d, "days")': 6, "dateDiff(d, n)": None, "d < now()": True,
            'dateAdd(d, 3, "days")': "2026-10-23", "year(d)": 2026, "day({Due date})": 1, 'prop("Due date")': "2026-11-01",
            "round(2.567, 1)": 2.6, "round(2.5)": 3, "min(a, b)": 4, "max(a, b, 9)": 9, "length(tags)": 2, 'contains(tags, "X")': True,
            "empty(n)": True, "0.1 + 0.2": 0.3, "IF(a > b, 1, 2)": 1,
        }
        for src, want in cases.items():
            with self.subTest(src):
                self.assertEqual(self.run_formula(src), want)

    def test_errors(self):
        for src in ["", "1 +", "(1", "1 2", "foo(1)", "if()", "1 / 0", "nosuch", "s * 2", "d + 1", "d < s", "a $ b", '"open',
                    "(" * 60 + "1" + ")" * 60, "x" * 2000, "round(1, 2, 3)", "round(1, 999999999)", 'dateAdd(d, 1e400, "days")']:
            with self.subTest(src[:30]):
                with self.assertRaises(formula.FormulaError):
                    self.run_formula(src)


class BasePrefsTests(unittest.TestCase):
    def test_round_trip_and_rejections(self):
        good = {"view": "gallery", "chartKind": "donut", "chartBy": "status",
                "filters": {"mode": "or", "items": [{"key": "a", "op": "equals", "value": "x"}]},
                "columns": [{"key": "t", "type": "formula", "expr": "a * 2"},
                            {"key": "r", "type": "rollup", "relation": "rel", "property": "p", "fn": "sum"}]}
        self.assertEqual(bases.clean_prefs(good), good)
        for bad in [{"view": "kanban"}, {"columns": [{"key": "f", "type": "formula", "expr": "1 +"}]},
                    {"filters": {"mode": "xor", "items": []}}, {"filters": {"mode": "and", "items": [{"key": "a", "op": "like", "value": ""}]}},
                    {"columns": [{"key": "a", "type": "text"}, {"key": "a", "type": "text"}]},
                    {"columns": [{"key": "r", "type": "rollup", "relation": "x", "property": "p", "fn": "avg"}]},
                    {"columns": [{"key": "title", "type": "text"}]}, []]:
            with self.subTest(bad):
                with self.assertRaises(ValueError):
                    bases.clean_prefs(bad)

        for value in (float("inf"), float("-inf"), float("nan")):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    bases.clean_prefs({"buttons": [{"label": "Set score", "key": "score", "value": value}]})

    def test_hand_edited_settings_are_read_leniently(self):
        prefs, errors = bases.parse_prefs({"view": "weird", "sort": {"key": "a", "dir": "up"}, "groupBy": "status"})
        self.assertEqual(prefs, {"groupBy": "status"})
        self.assertEqual(len(errors), 2)

    def test_relations(self):
        self.assertEqual(bases.relation_items(["[[A]]", "[[B|bee]]", "[[C#h]]"]), ["A", "B", "C"])
        self.assertEqual(bases.normalise([["A"], ["B"]]), ["[[A]]", "[[B]]"])  # unquoted YAML `[[A]]`
        self.assertTrue(bases.is_relation("[[A]]"))
        self.assertFalse(bases.is_relation(["[[A]]", "plain"]))
        self.assertEqual(bases.relation_items(["plain"], lenient=True), ["plain"])

    def test_rollups(self):
        targets = [bases.Target("a.md", "a", {"p": 3, "d": date(2026, 1, 2)}, {}), bases.Target("b.md", "b", {"p": 4.5, "d": "2026-03-04"}, {}),
                   bases.Target("c.md", "c", {}, {})]
        self.assertEqual(bases.rollup("count", "", targets), 3)
        self.assertEqual(bases.rollup("count", "p", targets), 2)
        self.assertEqual(bases.rollup("sum", "p", targets), 7.5)
        self.assertEqual(bases.rollup("min", "p", targets), 3)
        self.assertEqual(bases.rollup("max", "d", targets), "2026-03-04")
        self.assertIsNone(bases.rollup("max", "missing", targets))

    def test_cover_image(self):
        self.assertEqual(bases.first_image("text ![[a.png|200]] and ![x](b/c.jpg)", None), "a.png")
        self.assertEqual(bases.first_image("![x](b/c.jpg) then ![[a.png]]", None), "b/c.jpg")
        self.assertEqual(bases.first_image("![[doc.pdf]]", None), None)
        self.assertEqual(bases.first_image("![[a.png]]", "![[cover.webp]]"), "cover.webp")


class DiffTests(unittest.TestCase):
    def test_changes_and_gaps(self):
        old = "".join(f"{w}\n" for w in "one two three four five six seven eight nine ten".split())
        new = old.replace("two\n", "2\n") + "eleven\n"
        d = textdiff.line_diff(old, new)
        ops = [(x["op"], x.get("text")) for x in d["lines"]]
        self.assertIn(("del", "two"), ops)
        self.assertIn(("add", "2"), ops)
        self.assertIn(("add", "eleven"), ops)
        self.assertEqual((d["added"], d["removed"], d["identical"]), (2, 1, False))
        self.assertTrue(any(x["op"] == "gap" for x in d["lines"]))
        self.assertTrue(textdiff.line_diff("a\nb", "a\nb")["identical"])


class ImporterTests(unittest.TestCase):
    def pages(self, result: dict) -> dict:
        return {k: v for k, v in result.items() if not k.startswith("__") and isinstance(v, str)}

    def test_enex(self):
        red = png()
        digest = hashlib.md5(red).hexdigest()
        enex = f"""<?xml version="1.0"?><!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd"><en-export>
<note><title>Trip: A/B</title><created>20240131T101500Z</created><updated>20240201T080000Z</updated><tag>travel</tag>
<note-attributes><source-url>https://example.com</source-url></note-attributes>
<content><![CDATA[<en-note><div><b>Pack</b> &amp; go</div><div><en-todo checked="true"/>Book</div><div><en-todo/>Reserve</div>
<div><en-media type="image/png" hash="{digest}"/></div></en-note>]]></content>
<resource><data encoding="base64">{base64.b64encode(red).decode()}</data><mime>image/png</mime>
<resource-attributes><file-name>map.png</file-name></resource-attributes></resource></note>
<note><title>Trip: A/B</title><content><![CDATA[<en-note>same title</en-note>]]></content></note></en-export>""".encode()
        r = enex_import.convert(enex)
        notes = self.pages(r)
        self.assertEqual(sorted(notes), ["Evernote import/Trip- A-B 2.md", "Evernote import/Trip- A-B.md"])
        text = notes["Evernote import/Trip- A-B.md"]
        for want in ("tags:\n- travel", "source: https://example.com", "created: '2024-01-31", "**Pack** & go", "- [x] Book", "- [ ] Reserve", "![[map.png]]"):
            self.assertIn(want, text)
        self.assertEqual(r["Evernote import/attachments/map.png"], red)
        self.assertEqual(r["__stats__"]["pages"], 2)
        self.assertIn("Evernote import/Trip- A-B.md", r["__mtimes__"])
        for bad in (b"<other/>", b"not xml", b'<!DOCTYPE x [<!ENTITY a "b">]><en-export/>'):
            with self.assertRaises(ValueError):
                enex_import.convert(bad)

    def test_html_zip_links_and_images(self):
        red = png()
        page = (f'<html><head><title>Home</title></head><body><h1>Home</h1><p>See <a href="sub/about.html">About us</a> '
                f'<a href="https://x.org">web</a></p><img src="img/red.png" alt="r"><img src="data:image/png;base64,{base64.b64encode(png((1, 2, 3))).decode()}">'
                '<ol><li>One<li>Two</ol><table><tr><th>A</th><th>B|C</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>')
        about = '<html><head><title>About</title></head><body><h2>About us</h2><p><a href="../index.html">home</a></p><ul><li>x<ul><li>y</li></ul></li></ul></body></html>'
        r = html_import.convert(make_zip({"site/index.html": page, "site/sub/about.html": about, "site/img/red.png": red, "../evil.html": "<p>x</p>"}), "site.zip")
        notes = self.pages(r)
        self.assertEqual(sorted(notes), ["HTML import/Home.md", "HTML import/sub/about.md"])
        home = notes["HTML import/Home.md"]
        self.assertIn("[[about|About us]]", home)
        self.assertIn("[web](https://x.org)", home)
        self.assertIn("![[red.png]]", home)
        self.assertIn("1. One\n2. Two", home)
        self.assertIn("| A | B\\|C |\n| --- | --- |\n| 1 | 2 |", home)
        self.assertIn("[[Home]]", notes["HTML import/sub/about.md"])
        self.assertIn("- x\n  - y", notes["HTML import/sub/about.md"])
        self.assertEqual(r["__stats__"]["attachments"], 2)
        with self.assertRaises(ValueError):
            html_import.convert(b"x", "notes.pdf")

    def test_mht(self):
        red = png()
        mht = ("MIME-Version: 1.0\nContent-Type: multipart/related; boundary=\"B\"\n\n--B\nContent-Type: text/html; charset=\"utf-8\"\n"
               "Content-Location: file:///C:/p.htm\n\n<html><head><title>Page</title></head><body><p>Hi <b>there</b></p>"
               "<img src=\"p_files/i.png\"></body></html>\n--B\nContent-Type: image/png\nContent-Transfer-Encoding: base64\n"
               f"Content-Location: file:///C:/p_files/i.png\n\n{base64.b64encode(red).decode()}\n--B--\n").encode()
        r = html_import.convert(mht, "onenote.mht")
        self.assertIn("Hi **there**", r["HTML import/onenote.md"])
        self.assertIn("![[i.png]]", r["HTML import/onenote.md"])
        self.assertEqual(r["HTML import/attachments/i.png"], red)

    def test_docx(self):
        w = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
             'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"')

        def p(inner="", style=None, num=None):
            ppr = (f'<w:pStyle w:val="{style}"/>' if style else "") + (f'<w:numPr><w:ilvl w:val="{num[1]}"/><w:numId w:val="{num[0]}"/></w:numPr>' if num else "")
            return f"<w:p><w:pPr>{ppr}</w:pPr>{inner}</w:p>"

        def r(text, rpr=""):
            return f'<w:r><w:rPr>{rpr}</w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>'
        doc = (f'<w:document {w}><w:body>' + p(r("Report"), "Heading1") + p(r("Plain ") + r("bold", "<w:b/>") + r(" ") + r("it", "<w:i/>")
               + '<w:hyperlink r:id="rId9">' + r("site") + "</w:hyperlink>")
               + p(r("Apples"), num=(1, 0)) + p(r("Green"), num=(1, 1)) + p(r("Step"), num=(2, 0))
               + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>H1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>H2</w:t></w:r></w:p></w:tc></w:tr>'
                 '<w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b | c</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
               + p('<w:r><w:drawing><a:blip r:embed="rId8"/></w:drawing></w:r>') + "</w:body></w:document>")
        styles = f'<w:styles {w}><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>'
        numbering = (f'<w:numbering {w}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>'
                     '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>'
                     '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>')
        rels = ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId8" Target="media/image1.png"/>'
                '<Relationship Id="rId9" Target="https://example.com" TargetMode="External"/></Relationships>')
        core = ('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" '
                'xmlns:dcterms="http://purl.org/dc/terms/"><dc:creator>Pat</dc:creator><cp:keywords>a; b</cp:keywords><dcterms:created>2023-05-01T09:30:00Z</dcterms:created></cp:coreProperties>')
        blue = png((0, 0, 255))
        data = make_zip({"word/document.xml": doc, "word/styles.xml": styles, "word/numbering.xml": numbering, "word/_rels/document.xml.rels": rels,
                         "word/media/image1.png": blue, "docProps/core.xml": core})
        res = docx_import.convert(data, "Quarterly.docx")
        text = res["Word import/Quarterly.md"]
        for want in ("author: Pat", "- a\n- b", "# Report", "Plain **bold** *it*[site](https://example.com)", "- Apples\n  - Green", "\n\n1. Step",
                     "| H1 | H2 |\n| --- | --- |\n| a | b \\| c |", "![[Quarterly image1.png]]"):
            self.assertIn(want, text)
        self.assertEqual(res["Word import/attachments/Quarterly image1.png"], blue)
        for bad in (b"not a zip", make_zip({"x.txt": "y"})):
            with self.assertRaises(ValueError):
                docx_import.convert(bad, "x.docx")

    def test_markdown_zip(self):
        red = png()
        res = markdown_import.convert(make_zip({
            "Notes/Groceries.md": "# G\n\n![p](Attachments/red%20dot.png)\n\nSee [Recipes](Recipes.md).\n\n```\n![c](Attachments/red%20dot.png)\n```\n",
            "Notes/Recipes.md": "---\ntags: [food]\n---\nPancakes\n", "Notes/Attachments/red dot.png": red}), "notes.zip")
        g = res["Markdown import/Groceries.md"]
        self.assertIn("![[red dot.png]]", g)
        self.assertIn("[[Recipes]]", g)
        self.assertIn("![c](Attachments/red%20dot.png)", g)  # inside a code fence: untouched
        self.assertEqual(res["Markdown import/attachments/red dot.png"], red)
        self.assertTrue(res["Markdown import/Recipes.md"].startswith("---\ntags: [food]"))





def write_notes(root: Path, notes: dict[str, str]) -> None:
    for rel, text in notes.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")


def fresh_seconds() -> float:
    import server
    return server.GRAPH_FRESH_SECONDS


class VaultStorageTests(unittest.TestCase):
    def setUp(self):
        import server
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.vault = server.Vault(self.root)
        self.addCleanup(self.tmp.cleanup)

    def test_trash_paths_round_trip_slashes_and_underscores(self):
        paths = ("Budget/2026.md", "Budget__2026.md", "Course/Week__2/Math.md")
        for rel in paths:
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(rel, encoding="utf-8")
            self.vault.trash(rel)
            item = next(x for x in self.vault.trash_list() if x["path"] == rel)
            restored = self.vault.restore(item["id"])
            self.assertEqual(restored["path"], rel)
            self.assertEqual(path.read_text(encoding="utf-8"), rel)

    def test_legacy_trash_entries_still_use_their_original_decoder(self):
        self.assertEqual(self.vault._trash_original("1234567890123__Budget__2026.md")[0], "Budget/2026.md")
        self.assertEqual(self.vault._trash_original("1234567890123__v2__notes.md")[0], "v2/notes.md")

    def test_atomic_note_replace_preserves_existing_line_endings(self):
        path = self.root / "A.md"
        path.write_bytes(b"old\r\nline\r\n")
        self.vault.write_note(path, "new\nline\n")
        self.assertEqual(path.read_bytes(), b"new\r\nline\r\n")

    def test_failed_atomic_replace_keeps_original_and_removes_temporary_file(self):
        path = self.root / "A.md"
        path.write_text("old", encoding="utf-8")
        with patch("server.os.replace", side_effect=OSError("simulated replacement failure")):
            with self.assertRaises(OSError):
                self.vault.write_note(path, "new")
        self.assertEqual(path.read_text(encoding="utf-8"), "old")
        self.assertEqual(list(self.root.glob(".A.md.*.tmp")), [])




class StateAndWorkspaceTests(unittest.TestCase):
    TAB = {"id": "t1", "kind": "note", "path": "A.md"}

    def setUp(self):
        import server
        self.tmp = tempfile.TemporaryDirectory()
        self.v = server.Vault(Path(self.tmp.name))
        self.addCleanup(self.tmp.cleanup)

    def test_saves_change_only_what_they_carry(self):
        self.v.save_app_state({"tabs": [self.TAB], "active": "t1", "sort": "title-asc", "split": {"tab": "t2", "ratio": 0.4}})
        ws = {"Reading": {"tabs": [self.TAB], "active": "t1", "split": None}}
        self.v.save_app_state({"workspaces": ws})
        self.v.save_app_state({"tabs": [], "active": None, "split": None})  # a later tab save must not erase workspaces
        state = self.v.app_state()
        self.assertEqual(state["workspaces"], {"Reading": {"tabs": [self.TAB], "split": None, "active": "t1"}})
        self.assertEqual((state["tabs"], state["sort"]), ([], "title-asc"))
        self.assertNotIn("split", state)
        self.assertNotIn("active", state)

    def test_invalid_state_is_rejected_with_a_reason(self):
        bad = [({"tabs": "x"}, "tabs"), ({"tabs": [{"id": "a", "kind": "oops"}]}, "kind"), ({"split": {"tab": "a", "ratio": 2}}, "ratio"),
               ({"workspaces": {"": {"tabs": []}}}, "name"), ({"workspaces": {"w": {"tabs": [self.TAB], "active": 5}}}, "active"),
               ({"workspaces": {f"w{i}": {"tabs": []} for i in range(51)}}, "at most 50"), ({"tabs": [self.TAB] * 101}, "at most 100")]
        for raw, word in bad:
            with self.assertRaises(ValueError, msg=str(raw)[:60]) as cm:
                self.v.save_app_state(raw)
            self.assertIn(word, str(cm.exception))
        self.assertEqual(self.v.app_state(), {})




class NoteFeatureTests(unittest.TestCase):
    def setUp(self):
        import server
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "attachments").mkdir()
        (self.root / "attachments" / "sky.png").write_bytes(png())
        (self.root / "attachments" / "rec.webm").write_bytes(b"webm")
        write_notes(self.root, {"Tasks/One.md": "---\nstatus: todo\n---\nbody", "Tasks/Two.md": "---\nstatus: todo\n---\ntwo", "Tasks/Three.md": "no frontmatter"})
        self.v = server.Vault(self.root)
        self.addCleanup(self.tmp.cleanup)

    def text(self, rel):
        return (self.root / rel).read_text(encoding="utf-8")

    def test_button_sets_a_property_on_many_notes(self):
        r = self.v.set_meta_many(["Tasks/One.md", "Tasks/Two.md", "Tasks/Three.md", "Tasks/One.md", "Nope.md", "../x.md"], "status", "done")
        self.assertEqual((r["changed"], r["unchanged"]), (3, 0))
        self.assertEqual({f["path"] for f in r["failed"]}, {"Nope.md", "../x.md"})
        self.assertIn("status: done", self.text("Tasks/Three.md"))
        self.assertTrue(self.text("Tasks/Three.md").endswith("no frontmatter"))  # body untouched
        self.assertEqual(self.v.set_meta_many(["Tasks/One.md"], "status", "done")["unchanged"], 1)
        self.assertGreaterEqual(len(self.v.history("Tasks/One.md")), 1)  # undoable from version history

    def test_button_values_are_typed_and_templated(self):
        self.v.set_meta_many(["Tasks/One.md"], "reviewed", "{{date:YYYY-MM-DD}}")
        self.v.set_meta_many(["Tasks/One.md"], "n", 3)
        self.v.set_meta_many(["Tasks/One.md"], "ok", True)
        self.v.set_meta_many(["Tasks/Two.md"], "label", "About {{title}}")
        meta = self.v.entry(self.root / "Tasks" / "One.md").meta
        self.assertEqual((meta["n"], meta["ok"]), (3, True))
        self.assertIsInstance(meta["reviewed"], date)
        self.assertEqual(self.v.entry(self.root / "Tasks" / "Two.md").meta["label"], "About Two")
        self.v.set_meta_many(["Tasks/One.md"], "status", None)
        self.assertNotIn("status", self.v.entry(self.root / "Tasks" / "One.md").meta)

    def test_button_input_is_validated(self):
        for args in [("x", "k", 1), (["a.md"], " ", 1), (["a.md"], "k", {"a": 1}), (["a.md"], "k", ["l"]), ([1], "k", 1), (["a.md"] * 5001, "k", 1)]:
            with self.assertRaises(ValueError, msg=str(args)[:50]):
                self.v.set_meta_many(*args)

    def test_page_cover_comes_only_from_the_cover_property(self):
        self.v.set_meta("Tasks/One.md", "cover", "attachments/sky.png")
        info = self.v.info(self.root / "Tasks" / "One.md", with_body=True)
        self.assertEqual(info["coverUrl"], "/files/attachments/sky.png")
        self.assertIsNone(self.v.info(self.root / "Tasks" / "Two.md", with_body=True)["coverUrl"])
        write_notes(self.root, {"Tasks/Img.md": "![[sky.png]]"})  # a first image is a gallery cover, not a page cover
        self.assertIsNone(self.v.info(self.root / "Tasks" / "Img.md", with_body=True)["coverUrl"])
        remote = self.v.set_meta("Tasks/Two.md", "cover", "https://example.com/c.jpg")
        self.assertEqual(remote["coverUrl"], "https://example.com/c.jpg")
        self.assertIsNone(self.v.set_meta("Tasks/Two.md", "cover", None)["coverUrl"])

    def test_exported_notes_play_recordings_and_show_columns_as_a_callout(self):
        write_notes(self.root, {"Tasks/Audio.md": "![[rec.webm]]" + chr(10) * 2 + chr(10).join(["> [!columns]", ">", "> left", ">", "> ---", ">", "> right", ""])})
        html = publish.export_note_html(self.v, "Tasks/Audio.md")
        self.assertIn("<audio controls", html)
        self.assertIn("callout-columns", html)
        self.assertIn("left", html)
        self.assertIn("right", html)

    def test_images_lists_only_images(self):
        self.assertEqual([i["path"] for i in self.v.images()], ["attachments/sky.png"])


class HttpTests(unittest.TestCase):
    """The real server on an ephemeral port: ranges for audio, and the new routes."""

    @classmethod
    def setUpClass(cls):
        import server
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        (cls.root / "attachments").mkdir()
        cls.audio = bytes(range(256)) * 4
        (cls.root / "attachments" / "rec.webm").write_bytes(cls.audio)
        write_notes(cls.root, {"A.md": "---\nstatus: todo\n---\nhello [[B]]", "B.md": "b"})
        cls.srv = server.make_server(str(cls.root), 0)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def get(self, path, headers=None):
        try:
            with urllib.request.urlopen(urllib.request.Request(self.base + path, headers=headers or {})) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, dict(e.headers), e.read()

    def send(self, method, path, body):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read())

    def test_media_can_be_seeked_with_range_requests(self):
        url = "/files/attachments/rec.webm"
        status, headers, body = self.get(url)
        self.assertEqual((status, headers["Accept-Ranges"], body), (200, "bytes", self.audio))
        status, headers, body = self.get(url, {"Range": "bytes=10-19"})
        self.assertEqual((status, headers["Content-Range"], body), (206, "bytes 10-19/1024", self.audio[10:20]))
        self.assertEqual(self.get(url, {"Range": "bytes=1000-"})[2], self.audio[1000:])
        self.assertEqual(self.get(url, {"Range": "bytes=-5"})[2], self.audio[-5:])
        self.assertEqual(self.get(url, {"Range": "bytes=0-99999"})[2], self.audio)
        status, headers, _ = self.get(url, {"Range": "bytes=5000-6000"})
        self.assertEqual((status, headers["Content-Range"]), (416, "bytes */1024"))
        self.assertEqual(self.get(url, {"Range": "bytes=0-1,5-6"})[0], 200)  # several ranges: the whole file

    def test_new_routes(self):
        status, data = self.send("POST", "/api/notes/meta", {"paths": ["A.md", "B.md"], "key": "status", "value": "done"})
        self.assertEqual((status, data["changed"]), (200, 2))
        self.assertEqual(self.send("POST", "/api/notes/meta", {"paths": "A.md", "key": "k", "value": 1})[0], 400)
        self.assertEqual(self.send("PUT", "/api/state", {"workspaces": {"w": {"tabs": [{"id": "a", "kind": "graph"}]}}})[0], 200)
        self.assertEqual(self.send("PUT", "/api/state", {"split": {"tab": "a", "ratio": 5}})[0], 400)
        self.assertIn("w", json.loads(self.get("/api/state")[2])["workspaces"])
        self.assertEqual(self.get("/api/graph")[0], 404)


if __name__ == "__main__":
    unittest.main()
