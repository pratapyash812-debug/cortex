r"""Tests for tasks, query and database blocks, reminders and bookmarks.

Run:  server\.venv\Scripts\python -m unittest discover -s server\tests -v
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import blocks  # noqa: E402
import bookmarks  # noqa: E402
import queries  # noqa: E402
import reminders  # noqa: E402
import tasks  # noqa: E402
import toast  # noqa: E402

NL = chr(10)
TODAY = date(2026, 10, 26)
NOW = datetime(2026, 10, 26, 9, 30)


def write_notes(root: Path, notes: dict[str, str]) -> None:
    for rel, text in notes.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(text.encode("utf-8"))


def vault_with(notes: dict[str, str]):
    import server
    tmp = tempfile.TemporaryDirectory()
    root = Path(tmp.name)
    write_notes(root, notes)
    return tmp, root, server.Vault(root)


# ---- tasks -------------------------------------------------------------------------------------------------------
class TaskParsingTests(unittest.TestCase):
    def one(self, line: str) -> tasks.Task:
        found = tasks.parse(line)
        self.assertEqual(len(found), 1, line)
        return found[0]

    def test_the_three_due_syntaxes_are_all_read(self):
        for line in ("- [ ] Pay rent \U0001F4C5 2026-11-03", "- [ ] Pay rent due:: 2026-11-03", "- [ ] Pay rent [due:: 2026-11-03]",
                     "- [ ] Pay rent (due:: 2026-11-03)", "- [ ] Pay rent @due(2026-11-03)"):
            t = self.one(line)
            self.assertEqual((t.text, t.due, t.time), ("Pay rent", "2026-11-03", None), line)

    def test_time_in_each_spelling(self):
        for line in ("- [ ] x \U0001F4C5 2026-11-03 ⏰ 9:05", "- [ ] x @due(2026-11-03) time:: 09:05", "- [ ] x @due(2026-11-03 09:05)",
                     "- [ ] x \U0001F4C5 2026-11-03 09:05", "- [ ] x due:: 2026-11-03 [time:: 09:05]", "- [ ] x @due(2026-11-03) @time(9:05)"):
            t = self.one(line)
            self.assertEqual((t.text, t.due, t.time), ("x", "2026-11-03", "09:05"), line)
        self.assertIsNone(self.one("- [ ] x \U0001F4C5 2026-11-03 ⏰ 25:00").time)  # not a time of day

    def test_priority_in_each_spelling(self):
        cases = {"⏫": "high", "\U0001F53C": "medium", "\U0001F53D": "low", "!high": "high", "!Medium": "medium", "!med": "medium", "!low": "low",
                 "priority:: high": "high", "[priority:: low]": "low"}
        for mark, level in cases.items():
            t = self.one(f"- [ ] ship it {mark}")
            self.assertEqual((t.text, t.priority), ("ship it", level), mark)
        self.assertIsNone(self.one("- [ ] shout !important").priority)

    def test_tags_text_and_links(self):
        t = self.one("- [ ] Draft [[Homepage copy|the copy]] for [site](https://x.y) #web #projects/q4 \U0001F4C5 2026-11-03")
        self.assertEqual(t.text, "Draft the copy for site")
        self.assertEqual(t.tags, ("web", "projects/q4"))

    def test_impossible_dates_stay_in_the_text(self):
        t = self.one("- [ ] odd \U0001F4C5 2026-13-45")
        self.assertIsNone(t.due)
        self.assertIn("2026-13-45", t.text)

    def test_what_counts_as_a_task(self):
        text = NL.join(["- [ ] a", "* [x] b", "+ [X] c", "1. [ ] d", "2) [-] e", "  - [ ] f", "\t- [/] g", "> - [ ] h", "> > - [ ] i",
                        "- [x](link) not", "- [ ]", "- [] not", "-[ ] not", "- [ ]no", "plain [ ] text", "- [xx] not"])
        got = tasks.parse(text)
        self.assertEqual([t.text for t in got], list("abcdefghi"))
        self.assertEqual([t.done for t in got], [False, True, True, False, True, False, False, False, False])  # - is cancelled, / is in progress

    def test_code_and_frontmatter_are_not_scanned(self):
        text = NL.join(["```", "- [ ] in code", "```", "~~~md", "- [ ] tilde code", "~~~", "- [ ] real"])
        self.assertEqual([t.text for t in tasks.parse(text)], ["real"])

    def test_line_numbers_headings_and_nesting(self):
        text = NL.join(["intro", "# Plan", "- [ ] top", "  - [ ] child", "    - [x] grandchild", "- [ ] next top", "", "## Later", "- [ ] under later"])
        got = tasks.parse(text, 10)  # the body starts on line 10 of the file
        self.assertEqual([(t.line, t.heading, t.depth) for t in got],
                         [(12, "Plan", 0), (13, "Plan", 1), (14, "Plan", 2), (15, "Plan", 0), (18, "Later", 0)])
        self.assertEqual(got[0].raw, "- [ ] top")

    def test_ticking_changes_only_the_box(self):
        self.assertEqual(tasks.toggled("  - [ ] foo \U0001F4C5 2026-11-03  "), ("  - [x] foo \U0001F4C5 2026-11-03  ", True))
        self.assertEqual(tasks.toggled("> 1. [/] a"), ("> 1. [x] a", True))
        self.assertEqual(tasks.toggled("- [x] a"), ("- [ ] a", False))
        self.assertEqual(tasks.toggled("- [-] a"), ("- [ ] a", False))
        self.assertEqual(tasks.toggled("- [x] a", True), ("- [x] a", True))
        with self.assertRaises(ValueError):
            tasks.toggled("- not a task")


NOTES = {
    "Projects/Website.md": NL.join(["---", "tags: [work]", "---", "# Tasks", "- [ ] Overdue one \U0001F4C5 2026-10-20 #web",
                                    "- [ ] Today at nine \U0001F4C5 2026-10-26 ⏰ 09:00 ⏫", "- [x] Finished \U0001F4C5 2026-10-25",
                                    "- [ ] Later \U0001F4C5 2026-11-02 \U0001F53D", "- [ ] No date at all", ""]),
    "Home.md": "- [ ] Buy milk @due(2026-10-27)\n- [ ] Tidy up #chores\n",
}




class TaskToggleTests(unittest.TestCase):
    def setUp(self):
        self.tmp, self.root, self.v = vault_with({"A.md": NL.join(["---", "x: 1", "---", "# H", "- [ ] one", "- [ ] two", "- [ ] two", "end", ""])})
        self.addCleanup(self.tmp.cleanup)

    def text(self):
        return (self.root / "A.md").read_bytes().decode("utf-8")

    def test_ticks_the_task_and_keeps_a_version(self):
        r = self.v.toggle_task("A.md", 5, "- [ ] one")
        self.assertEqual((r["done"], r["changed"], r["moved"], r["raw"]), (True, True, False, "- [x] one"))
        self.assertIn("- [x] one" + NL + "- [ ] two", self.text())
        self.assertEqual(len(self.v.history("A.md")), 1)
        self.assertIn("- [ ] one", self.v.version("A.md", self.v.history("A.md")[0]["id"]))
        self.assertTrue(self.v.toggle_task("A.md", 5, "- [x] one")["changed"])  # and back
        self.assertIn("- [ ] one", self.text())

    def test_an_explicit_state_is_idempotent(self):
        self.v.toggle_task("A.md", 5, "- [ ] one", True)
        again = self.v.toggle_task("A.md", 5, "- [x] one", True)
        self.assertEqual((again["done"], again["changed"]), (True, False))

    def test_only_the_box_changes_and_crlf_files_stay_crlf(self):
        (self.root / "A.md").write_bytes(b"- [ ] one\r\n- [ ] two\r\n")
        self.v.toggle_task("A.md", 1, "- [ ] one")
        self.assertEqual((self.root / "A.md").read_bytes(), b"- [x] one\r\n- [ ] two\r\n")

    def test_a_line_that_moved_is_followed_when_it_is_still_unique(self):
        write_notes(self.root, {"A.md": "new line on top" + NL + self.text()})  # everything shifted down by one
        r = self.v.toggle_task("A.md", 5, "- [ ] one")
        self.assertEqual((r["line"], r["moved"]), (6, True))
        self.assertIn("- [x] one", self.text())

    def test_a_task_edited_since_is_a_conflict_and_nothing_is_written(self):
        write_notes(self.root, {"A.md": self.text().replace("- [ ] one", "- [ ] one, reworded")})
        before = self.text()
        import server
        with self.assertRaises(server.TaskConflict):
            self.v.toggle_task("A.md", 5, "- [ ] one")
        self.assertEqual(self.text(), before)
        self.assertEqual(self.v.history("A.md"), [])

    def test_two_identical_lines_that_moved_cannot_be_told_apart(self):
        import server
        write_notes(self.root, {"A.md": "x" + NL + self.text()})
        with self.assertRaises(server.TaskConflict):
            self.v.toggle_task("A.md", 6, "- [ ] two")
        # but at the line the caller saw, an identical neighbour is no problem
        write_notes(self.root, {"A.md": self.text()[2:]})
        self.assertEqual(self.v.toggle_task("A.md", 7, "- [ ] two")["line"], 7)

    def test_bad_requests(self):
        import server
        with self.assertRaises(ValueError):
            self.v.toggle_task("A.md", 8, "end")  # not a task
        with self.assertRaises(server.TaskConflict):
            self.v.toggle_task("A.md", 99, "- [ ] nothing like this")
        with self.assertRaises(ValueError):
            self.v.toggle_task("A.md", "5", "- [ ] one")
        with self.assertRaises(FileNotFoundError):
            self.v.toggle_task("Missing.md", 1, "- [ ] x")
        with self.assertRaises(ValueError):
            self.v.toggle_task("../outside.md", 1, "- [ ] x")


# ---- queries and blocks ------------------------------------------------------------------------------------------
class QueryParsingTests(unittest.TestCase):
    def test_a_query_line(self):
        q = queries.parse_query('tag:projects status!=Done "due date"<=today+7 sort:-due limit:5 view:table columns:status,due folder:Work has:owner no:done -draft')
        self.assertEqual(q.search, 'tag:projects -draft')
        self.assertEqual(q.folder, "Work")
        self.assertEqual([f.as_dict() for f in q.filters], [
            {"key": "status", "op": "ne", "values": ["Done"]}, {"key": "due date", "op": "lte", "values": ["today+7"]},
            {"key": "owner", "op": "notempty", "values": []}, {"key": "done", "op": "empty", "values": []}])
        self.assertEqual((q.sort, q.limit, q.view, q.columns), (("due", "desc"), 5, "table", ("status", "due")))

    def test_values_alternatives_and_quotes(self):
        self.assertEqual(queries.parse_query("status=Todo,Doing").filters[0].values, ("Todo", "Doing"))
        self.assertEqual(queries.parse_query('status="In progress, soon"').filters[0].values, ("In progress, soon",))
        f = queries.parse_query("-status~wip").filters[0]
        self.assertEqual((f.op, f.values), ("notcontains", ("wip",)))
        self.assertEqual(queries.parse_query('"Due date">2026-01-01').filters[0].key, "Due date")

    def test_search_operators_pass_through_untouched(self):
        q = queries.parse_query('tag:a OR tag:b "exact phrase" /re[gx]+/ path:Proj -skip')
        self.assertEqual(q.search, 'tag:a OR tag:b "exact phrase" /re[gx]+/ path:Proj -skip')
        self.assertEqual(q.filters, ())

    def test_sort_forms(self):
        for text, want in {"due": ("due", "asc"), "-due": ("due", "desc"), "due:desc": ("due", "desc"), "due desc": ("due", "desc"),
                           "+due": ("due", "asc"), '"Due date":desc': ("Due date", "desc")}.items():
            self.assertEqual(queries.parse_sort(text), want, text)

    def test_mistakes_are_reported(self):
        for text in ("limit:0", "limit:many", "view:cube", "folder:a folder:b", "-due<3", "sort:"):
            with self.assertRaises(queries.QueryError, msg=text):
                queries.parse_query(text)

    def test_filter_expressions_and_saved_filters(self):
        self.assertEqual(queries.parse_expression("status != Done").as_dict(), {"key": "status", "op": "ne", "values": ["Done"]})
        self.assertEqual(queries.parse_expression("owner is empty").op, "empty")
        self.assertEqual(queries.parse_expression("owner is not empty").op, "notempty")
        self.assertEqual(queries.parse_expression("done is checked").op, "checked")
        self.assertEqual(queries.parse_expression("Due Date <= today").key, "Due Date")
        self.assertEqual(queries.parse_saved_filter({"key": "status", "op": "equals", "value": "Done"}).op, "eq")
        self.assertEqual(queries.parse_saved_filter({"key": "n", "op": "gte", "value": 3}).values, ("3",))
        for bad in ("nonsense", "= x", "status != "):
            if bad == "status != ":
                continue  # an empty value is allowed: it matches notes whose property is blank
            with self.assertRaises(queries.QueryError, msg=bad):
                queries.parse_expression(bad)
        with self.assertRaises(queries.QueryError):
            queries.parse_saved_filter({"key": "x", "op": "regex"})

    def test_matching(self):
        m = lambda value, op, *want: queries.matches(value, queries.Filter("k", op, tuple(want)), TODAY)  # noqa: E731
        self.assertTrue(m("Done", "eq", "done"))
        self.assertTrue(m(["a", "b"], "eq", "x", "b"))
        self.assertTrue(m(5, "eq", "5.0") and m(5.0, "eq", "5"))
        self.assertTrue(m(True, "eq", "true"))
        self.assertTrue(m(None, "ne", "Done") and m("", "ne", "Done"))   # nothing is not "Done"
        self.assertFalse(m(None, "eq", "Done") or m(None, "gt", "1") or m(None, "contains", "x"))
        self.assertTrue(m("Write the plan", "contains", "PLAN") and m(None, "notcontains", "x"))
        self.assertTrue(m(10, "gt", "9") and not m("10", "lt", "9"))                      # numbers by size, not text
        self.assertTrue(m("2026-10-25", "lt", "today") and m("2026-10-26", "lte", "today") and m("2026-11-02", "lte", "today+7"))
        self.assertTrue(m("2026-10-26 15:00", "eq", "2026-10-26") is False)               # a datetime is not equal to a day...
        self.assertTrue(m("2026-10-26 15:00", "lte", "2026-10-26"))                        # ...but compares by day
        self.assertTrue(m("2026-10-26 15:00", "gt", "2026-10-26 09:00"))                   # and by minute when both have one
        self.assertTrue(m("banana", "gt", "apple"))
        self.assertTrue(m([], "empty") and m("", "empty") and m("x", "notempty") and not m(0, "empty"))
        self.assertTrue(m(True, "checked") and m(None, "unchecked") and m(False, "unchecked"))
        self.assertEqual(queries.resolve_day("tomorrow", TODAY), "2026-10-27")
        self.assertEqual(queries.resolve_day("today-3", TODAY), "2026-10-23")
        self.assertEqual(queries.resolve_day("yesterday", TODAY), "2026-10-25")
        self.assertEqual(queries.resolve_day("soon", TODAY), "soon")

    def test_sorting_puts_empty_values_last_either_way(self):
        rows = [{"v": 10}, {"v": None}, {"v": 2}, {"v": 33}, {"v": ""}]
        self.assertEqual([r["v"] for r in queries.sort_rows(rows, lambda r: r["v"], "asc")], [2, 10, 33, None, ""])
        self.assertEqual([r["v"] for r in queries.sort_rows(rows, lambda r: r["v"], "desc")], [33, 10, 2, None, ""])
        words = [{"v": "b"}, {"v": "A"}, {"v": "c"}]
        self.assertEqual([r["v"] for r in queries.sort_rows(words, lambda r: r["v"], "asc")], ["A", "b", "c"])


class BlockSpecTests(unittest.TestCase):
    def test_base_block(self):
        spec = blocks.parse("base", NL.join(["scope: folder:Projects", "view: board", "groupBy: status", "match: any", "filters:", "  - status != Done",
                                              "  - {key: due, op: lt, value: today}", "sort: due desc", "columns: [status, due]", "limit: 20", "title: Open work"]))
        self.assertEqual((spec["folder"], spec["tag"], spec["view"], spec["mode"], spec["limit"], spec["title"]), ("Projects", "", "board", "or", 20, "Open work"))
        self.assertEqual(spec["sort"], {"key": "due", "dir": "desc"})
        self.assertEqual(spec["columns"], ["status", "due"])
        self.assertEqual(spec["options"], {"groupBy": "status"})
        self.assertEqual([f["op"] for f in spec["filters"]], ["ne", "lt"])

    def test_scope_spellings(self):
        for source, want in {"scope: tag:projects": ("", "projects"), "scope: '#projects'": ("", "projects"), "scope: Projects/Sub": ("Projects/Sub", ""),
                             "folder: A\ntag: b": ("A", "b"), "scope: all": ("", ""), "view: table": ("", "")}.items():
            spec = blocks.parse("base", source)
            self.assertEqual((spec["folder"], spec["tag"]), want, source)

    def test_every_problem_is_listed(self):
        with self.assertRaises(queries.QueryError) as caught:
            blocks.parse("base", NL.join(["view: cube", "limit: -1", "filters: [nonsense]", "colour: red", "match: sometimes", "scope: A", "tag: b"]))
        message = str(caught.exception)
        for part in ("view must be one of", "limit must be", "cannot read the filter", 'unknown option "colour"', "match must be", "either scope or folder"):
            self.assertIn(part, message)

    def test_yaml_errors_say_where(self):
        with self.assertRaises(queries.QueryError) as caught:
            blocks.parse("base", "view: [table\nlimit: 3")
        self.assertIn("not valid YAML", str(caught.exception))
        with self.assertRaises(queries.QueryError):
            blocks.parse("base", "- just\n- a list")

    def test_query_block(self):
        spec = blocks.parse("query", "tag:projects status!=Done sort:due")
        self.assertEqual((spec["kind"], spec["tag"], spec["view"], spec["search"]), ("query", "projects", "list", "tag:projects"))
        self.assertEqual(blocks.parse("query", "tag:a OR tag:b")["tag"], "")  # two tags: no single database to open
        self.assertEqual(blocks.parse("query", "view:table")["view"], "table")
        with self.assertRaises(queries.QueryError):
            blocks.parse("query", "limit:zero")

    def test_tasks_block(self):
        spec = blocks.parse("tasks", NL.join(["folder: Projects", "tag: '#web'", "status: all", "due: overdue", "priority: high", "group: note", "limit: 900"]))
        self.assertEqual(spec["filter"]["folder"], "Projects")
        self.assertEqual((spec["filter"]["status"], spec["filter"]["due"], spec["group"], spec["limit"]), ("all", "overdue", "note", blocks.TASK_LIMIT))
        self.assertEqual(blocks.parse("tasks", "")["limit"], 50)
        with self.assertRaises(queries.QueryError) as caught:
            blocks.parse("tasks", "status: nope\ngroup: tree\nwhen: soon")
        self.assertIn('unknown option "when"', str(caught.exception))

    def test_unknown_kind_and_oversized_source(self):
        with self.assertRaises(queries.QueryError):
            blocks.parse("chart", "")
        with self.assertRaises(queries.QueryError):
            blocks.parse("query", "x" * (blocks.MAX_SOURCE + 1))


DB_NOTES = {
    "Projects/Alpha.md": "---\nstatus: Doing\ndue: 2026-10-30\nowner: Ann\nprice: 5\ntags: [projects]\n---\nAlpha body about launch",
    "Projects/Beta.md": "---\nstatus: Done\ndue: 2026-10-20\nowner: Bob\nprice: 12\ntags: [projects]\n---\nBeta body",
    "Projects/Gamma.md": "---\nstatus: Todo\ndue: 2026-11-15\nprice: 7\n---\nGamma body with #projects tag",
    "Projects/Delta.md": "---\nstatus: Todo\nprice: 1\n---\nno date, no owner",
    "Other/Epsilon.md": "---\nstatus: Doing\ndue: 2026-10-28\ntags: [elsewhere]\n---\nEpsilon",
}




# ---- reminders ---------------------------------------------------------------------------------------------------
REMIND_NOTES = {
    "Tasks.md": NL.join(["- [ ] Call the bank \U0001F4C5 2026-10-26 ⏰ 09:00", "- [ ] Water plants \U0001F4C5 2026-10-26", "- [ ] Later \U0001F4C5 2026-10-28 ⏰ 14:00",
                         "- [x] Done already \U0001F4C5 2026-10-26", "- [ ] No date", "- [ ] Too old \U0001F4C5 2026-09-01", ""]),
    "Trip.md": "---\nremind: 2026-10-27 08:15\n---\nPack",
    "Birthday.md": "---\nremind: 2026-10-26\n---\n",
    "Tomorrow.md": "---\nremind: 2026-10-27T18:00:00\n---\n",
    "Odd.md": "---\nremind: someday\n---\n",
}


class ReminderTests(unittest.TestCase):
    def setUp(self):
        self.tmp, self.root, self.v = vault_with(REMIND_NOTES)
        self.addCleanup(self.tmp.cleanup)
        self.told: list[tuple[str, str]] = []
        self.svc = reminders.Service(self.v, self.root / ".cortex", notify=lambda title, text: self.told.append((title, text)) or True)

    def by_title(self, listing, part="due"):
        return {r["title"]: r for r in listing[part]}

    def test_what_asks_for_a_reminder(self):
        found = {r["title"]: r for r in self.svc.all()}
        self.assertEqual(set(found), {"Call the bank", "Water plants", "Later", "Too old", "Trip", "Birthday", "Tomorrow"})  # not done, undated or unreadable ones
        self.assertEqual((found["Call the bank"]["when"], found["Call the bank"]["allDay"]), ("2026-10-26T09:00", False))
        self.assertEqual((found["Water plants"]["when"], found["Water plants"]["allDay"]), ("2026-10-26T09:00", True))  # no time: the default 09:00
        self.assertEqual(found["Trip"]["when"], "2026-10-27T08:15")
        self.assertEqual(found["Tomorrow"]["when"], "2026-10-27T18:00")  # a YAML datetime
        self.assertEqual((found["Birthday"]["when"], found["Birthday"]["kind"], found["Birthday"]["path"]), ("2026-10-26T09:00", "note", "Birthday.md"))
        self.assertEqual((found["Later"]["kind"], found["Later"]["line"], found["Later"]["path"]), ("task", 3, "Tasks.md"))

    def test_note_remind_values(self):
        import datetime as dt
        self.assertEqual(reminders.note_moment(dt.date(2026, 11, 1)), (datetime(2026, 11, 1, 9, 0), True))
        self.assertEqual(reminders.note_moment(datetime(2026, 11, 1, 7, 5, 59)), (datetime(2026, 11, 1, 7, 5), False))
        self.assertEqual(reminders.note_moment("2026-11-01 7:05"), (datetime(2026, 11, 1, 7, 5), False))
        self.assertEqual(reminders.note_moment("2026-11-01 07:05:30"), (datetime(2026, 11, 1, 7, 5), False))
        for bad in ("soon", "2026-13-01", "2026-11-01 25:00", 5, None, ["2026-11-01"]):
            self.assertIsNone(reminders.note_moment(bad), bad)

    def test_due_and_upcoming(self):
        listing = self.svc.listing(NOW)
        self.assertEqual(set(self.by_title(listing)), {"Call the bank", "Water plants", "Birthday", "Too old"} - {"Too old"})  # 09:00 has passed; the old one is dropped
        self.assertEqual([r["title"] for r in listing["upcoming"]], ["Trip", "Tomorrow", "Later"])
        self.assertEqual(listing["now"], "2026-10-26T09:30")
        before = self.svc.listing(datetime(2026, 10, 26, 8, 59))
        self.assertEqual(before["due"], [])
        self.assertEqual(len(before["upcoming"]), 6)

    def test_each_reminder_is_told_once_when_it_comes_due(self):
        self.assertEqual(self.svc.tick(datetime(2026, 10, 26, 8, 0)), [])
        told = self.svc.tick(NOW)
        self.assertEqual(sorted(r["title"] for r in told), ["Birthday", "Call the bank", "Water plants"])
        self.assertEqual(len(self.told), 3)
        titles = dict(self.told)
        self.assertEqual(titles["Task due at 09:00"], "Call the bank (Tasks)")
        self.assertEqual(titles["Task due today"], "Water plants (Tasks)")
        self.assertEqual(titles["Reminder"], "Birthday")
        self.assertEqual(self.svc.tick(NOW + timedelta(minutes=1)), [])            # not again
        self.assertEqual(len(self.told), 3)
        later = self.svc.tick(datetime(2026, 10, 27, 8, 15))
        self.assertEqual([r["title"] for r in later], ["Trip"])
        self.assertEqual(self.told[-1], ("Reminder at 08:15", "Trip"))

    def test_a_told_reminder_stays_listed_until_done(self):
        self.svc.tick(NOW)
        self.assertTrue(self.by_title(self.svc.listing(NOW))["Call the bank"]["told"])
        self.svc.done(self.by_title(self.svc.listing(NOW))["Call the bank"]["id"], NOW)
        self.assertNotIn("Call the bank", self.by_title(self.svc.listing(NOW)))
        self.assertTrue((self.root / ".cortex" / "reminders.json").is_file())
        again = reminders.Service(self.v, self.root / ".cortex")  # a restart keeps it
        self.assertNotIn("Call the bank", self.by_title(again.listing(NOW)))

    def test_what_came_due_while_closed_is_listed_but_not_announced(self):
        week_later = datetime(2026, 11, 2, 12, 0)
        self.assertEqual(self.svc.tick(week_later), [])
        self.assertEqual(self.told, [])
        self.assertIn("Call the bank", self.by_title(self.svc.listing(week_later)))   # still there to deal with
        just_closed = datetime(2026, 10, 27, 7, 0)  # 22 hours after the 09:00 ones
        self.assertEqual(len(self.svc.tick(just_closed)), 3)

    def test_snooze_moves_it_and_it_is_told_again_then(self):
        self.svc.tick(NOW)
        rid = self.by_title(self.svc.listing(NOW))["Water plants"]["id"]
        after = self.svc.snooze(rid, minutes=45, now=NOW)
        self.assertNotIn("Water plants", self.by_title(after))
        snoozed = self.by_title(after, "upcoming")["Water plants"]
        self.assertEqual((snoozed["due"], snoozed["snoozed"]), ("2026-10-26T10:15", True))
        self.assertEqual(self.svc.tick(datetime(2026, 10, 26, 10, 0)), [])
        told = self.svc.tick(datetime(2026, 10, 26, 10, 16))
        self.assertEqual([r["title"] for r in told], ["Water plants"])
        self.assertEqual(self.told[-1][1], "Water plants (Tasks)")
        self.assertIn("Water plants", self.by_title(self.svc.listing(datetime(2026, 10, 26, 10, 16))))  # due again, until Done
        self.assertEqual(self.svc.snooze(rid, until="2026-10-29T07:00", now=NOW)["upcoming"][-1]["due"], "2026-10-29T07:00")

    def test_snooze_is_validated(self):
        rid = self.svc.all()[0]["id"]
        for kwargs in ({}, {"minutes": 0}, {"minutes": -5}, {"minutes": "5"}, {"minutes": True}, {"until": "tomorrow"}, {"until": "2026-10-26T09:00"},
                       {"until": "2030-01-01T09:00"}, {"minutes": 60 * 24 * 400}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                self.svc.snooze(rid, now=NOW, **kwargs)
        with self.assertRaises(FileNotFoundError):
            self.svc.snooze("t:nothing", minutes=5, now=NOW)
        with self.assertRaises(FileNotFoundError):
            self.svc.done("t:nothing", NOW)

    def test_finishing_the_task_or_changing_the_date_ends_or_renews_the_reminder(self):
        self.v.toggle_task("Tasks.md", 1, "- [ ] Call the bank \U0001F4C5 2026-10-26 ⏰ 09:00")
        self.assertNotIn("Call the bank", {r["title"] for r in self.svc.all()})
        self.svc.tick(NOW)
        write_notes(self.root, {"Trip.md": "---\nremind: 2026-10-26 09:10\n---\nPack"})   # a new time is a new reminder
        self.assertIn("Trip", [r["title"] for r in self.svc.tick(datetime(2026, 10, 26, 9, 31))])

    def test_the_same_task_text_twice_gets_two_ids(self):
        write_notes(self.root, {"Twice.md": "- [ ] Stretch \U0001F4C5 2026-10-30\n- [ ] Stretch \U0001F4C5 2026-10-30\n"})
        ids = [r["id"] for r in self.svc.all() if r["title"] == "Stretch"]
        self.assertEqual(len(ids), 2)
        self.assertEqual(len(set(ids)), 2)

    def test_state_of_vanished_reminders_is_forgotten_only_when_old(self):
        self.svc.tick(NOW)
        state = self.svc.store.load()
        state["fired"]["t:gone"] = "2026-10-20T09:00"
        state["done"]["t:ancient"] = "2026-06-01T09:00"
        self.svc.store.save(state)
        self.svc.tick(NOW + timedelta(minutes=1))
        kept = self.svc.store.load()
        self.assertIn("t:gone", kept["fired"])
        self.assertNotIn("t:ancient", kept["done"])

    def test_a_broken_state_file_is_just_empty(self):
        (self.root / ".cortex" / "reminders.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(len(self.svc.tick(NOW)), 3)
        (self.root / ".cortex" / "reminders.json").write_text('{"fired": 5, "done": {"x": 1}}', encoding="utf-8")
        self.assertEqual(self.svc.store.load(), {"fired": {}, "snoozed": {}, "done": {}})

    def test_a_failing_notifier_does_not_stop_the_rest(self):
        calls = []

        def boom(title, text):
            calls.append(title)
            raise OSError("no tray")
        svc = reminders.Service(self.v, self.root / ".cortex2", notify=boom)
        import contextlib
        import io
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(len(svc.tick(NOW)), 3)
        self.assertEqual(len(calls), 3)


class ToastTests(unittest.TestCase):
    def test_other_systems_say_no(self):
        if toast.IS_WINDOWS:
            self.skipTest("Windows can show it")
        self.assertFalse(toast.Toaster().send("t", "x"))


# ---- bookmarks ---------------------------------------------------------------------------------------------------


# ---- the HTTP routes ---------------------------------------------------------------------------------------------
class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import server
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        write_notes(cls.root, {**DB_NOTES, "Tasks.md": NOTES["Home.md"], "Remind.md": f"---\nremind: {date.today() - timedelta(days=1)}\n---\n"})
        cls.srv = server.make_server(str(cls.root), 0)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read())



    def test_tabs_can_be_the_tasks_page(self):
        self.assertEqual(self.call("PUT", "/api/state", {"tabs": [{"id": "t1", "kind": "tasks"}]})[0], 200)


if __name__ == "__main__":
    unittest.main()
