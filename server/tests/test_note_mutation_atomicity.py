"""Task/link mutations and filename allocation must not overwrite another write."""
from __future__ import annotations

import json
import sys
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server
import test_metadata_atomicity as transactions


class NoteMutationAtomicityTests(unittest.TestCase):
    setUp = transactions.MetadataAtomicityTests.setUp
    tearDown = transactions.MetadataAtomicityTests.tearDown
    interleave = transactions.MetadataAtomicityTests.interleave
    read_note = transactions.MetadataAtomicityTests.read_note

    def interleave_allocation(self, first, second):
        selected, release_first, second_ready = (threading.Event() for _ in range(3))
        original_unique = self.vault.unique
        self.vault._note_save_lock = transactions.ObservedLock(self.vault._note_save_lock, 'allocation-second', second_ready)
        errors, results = {}, {}

        def unique(*args, **kwargs):
            path = original_unique(*args, **kwargs)
            if threading.current_thread().name == 'allocation-first':
                selected.set()
                if not release_first.wait(4):
                    raise TimeoutError('first filename was never released')
            return path

        def run(name, operation):
            try:
                results[name] = operation()
            except BaseException as error:
                errors[name] = error
            finally:
                if name == 'second':
                    second_ready.set()

        one = threading.Thread(target=run, args=('first', first), name='allocation-first', daemon=True)
        two = threading.Thread(target=run, args=('second', second), name='allocation-second', daemon=True)
        with patch.object(self.vault, 'unique', unique):
            one.start()
            try:
                self.assertTrue(selected.wait(3), 'first filename was not selected')
                two.start()
                self.assertTrue(second_ready.wait(3), 'second allocation neither completed nor blocked')
            finally:
                release_first.set()
                one.join(3)
                if two.ident is not None:
                    two.join(3)
        self.assertFalse(one.is_alive() or two.is_alive(), 'allocation deadlock')
        self.assertEqual(errors, {})
        return results

    def test_body_save_then_task_toggle_retains_the_new_body(self):
        self.path.write_text('- [ ] Practice\noriginal lecture\n', encoding='utf-8')
        base = self.vault.info(self.path)['revision']
        self.vault.forget(self.path)
        errors, results = self.interleave(
            lambda: self.vault.save('A.md', 'New introduction\n- [ ] Practice\nnew lecture\n', None, base),
            lambda: self.vault.toggle_task('A.md', 1, '- [ ] Practice', True),
        )
        self.assertEqual(errors, {})
        self.assertEqual(self.read_note()[1], 'New introduction\n- [x] Practice\nnew lecture\n')
        self.assertTrue(results['second']['moved'])

    def test_task_toggle_then_old_conditional_save_conflicts(self):
        self.path.write_text('- [ ] Practice\noriginal lecture\n', encoding='utf-8')
        base = self.vault.info(self.path)['revision']
        errors, _ = self.interleave(
            lambda: self.vault.toggle_task('A.md', 1, '- [ ] Practice', True),
            lambda: self.vault.save('A.md', 'stale replacement\n', None, base),
        )
        self.assertNotIn('first', errors)
        self.assertIsInstance(errors.get('second'), server.NoteConflict)
        self.assertEqual(self.read_note()[1], '- [x] Practice\noriginal lecture\n')

    def test_concurrent_distinct_task_toggles_keep_both_boxes(self):
        self.path.write_text('- [ ] Math\n- [ ] Science\n', encoding='utf-8')
        errors, _ = self.interleave(
            lambda: self.vault.toggle_task('A.md', 1, '- [ ] Math', True),
            lambda: self.vault.toggle_task('A.md', 2, '- [ ] Science', True),
        )
        self.assertEqual(errors, {})
        self.assertEqual(self.read_note()[1], '- [x] Math\n- [x] Science\n')

    def test_link_mention_then_old_conditional_save_conflicts(self):
        (self.root / 'Biology.md').write_text('Cell notes', encoding='utf-8')
        self.path.write_text('Revise Biology.\n', encoding='utf-8')
        base = self.vault.info(self.path)['revision']
        self.vault.forget(self.path)
        errors, _ = self.interleave(
            lambda: self.vault.link_mention('A.md', 'Biology.md'),
            lambda: self.vault.save('A.md', 'Revise Biology.\nNew observations.\n', None, base),
        )
        self.assertNotIn('first', errors)
        self.assertIsInstance(errors.get('second'), server.NoteConflict)
        self.assertEqual(self.read_note()[1], 'Revise [[Biology]].\n')

    def test_body_save_then_link_mention_preserves_new_observations(self):
        (self.root / 'Biology.md').write_text('Cell notes', encoding='utf-8')
        self.path.write_text('Revise Biology.\n', encoding='utf-8')
        base = self.vault.info(self.path)['revision']
        self.vault.forget(self.path)
        errors, _ = self.interleave(
            lambda: self.vault.save('A.md', 'Revise Biology.\nNew observations.\n', None, base),
            lambda: self.vault.link_mention('A.md', 'Biology.md'),
        )
        self.assertEqual(errors, {})
        self.assertEqual(self.read_note()[1], 'Revise [[Biology]].\nNew observations.\n')

    def test_concurrent_same_title_notes_get_distinct_paths_and_bodies(self):
        results = self.interleave_allocation(
            lambda: self.vault.create('', 'Revision', 'Math revision'),
            lambda: self.vault.create('', 'Revision', 'Science revision'),
        )
        self.assertCountEqual([item['path'] for item in results.values()], ['Revision.md', 'Revision 2.md'])
        self.assertCountEqual([self.vault.split(path.read_text(encoding='utf-8'))[1] for path in self.root.glob('Revision*.md')],
                              ['Math revision', 'Science revision'])

    def test_concurrent_same_title_canvases_keep_both_diagrams(self):
        math = {'nodes': [{'id': 'math', 'type': 'text', 'text': 'Math diagram'}], 'edges': []}
        science = {'nodes': [{'id': 'science', 'type': 'text', 'text': 'Science diagram'}], 'edges': []}
        results = self.interleave_allocation(
            lambda: self.vault.create_canvas('', 'Revision', math),
            lambda: self.vault.create_canvas('', 'Revision', science),
        )
        self.assertCountEqual([item['path'] for item in results.values()], ['Revision.canvas', 'Revision 2.canvas'])
        diagrams = [json.loads(path.read_text(encoding='utf-8')) for path in self.root.glob('Revision*.canvas')]
        self.assertCountEqual([data['nodes'][0]['text'] for data in diagrams], ['Math diagram', 'Science diagram'])



class CanvasCreationHttpTests(unittest.TestCase):
    setUp = transactions.MetadataAtomicityTests.setUp
    tearDown = transactions.MetadataAtomicityTests.tearDown

    def test_post_canvas_preserves_existing_canvas_and_ignores_note_suffix_collision(self):
        course = self.root / 'Course'
        course.mkdir()
        original = b'{"nodes":[{"id":"student","type":"text","text":"Exam map"}],"edges":[]}\r\n'
        (course / 'Revision.canvas').write_bytes(original)
        (course / 'Only a note.md').write_text('Keep my note', encoding='utf-8')
        httpd = server.make_server(str(self.root), 0, background_ai=False, watch=False, background_sync=False, background_reminders=False)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()

        def post(title):
            request = urllib.request.Request(f'http://127.0.0.1:{httpd.server_port}/api/canvas',
                data=json.dumps({'folder':'Course','title':title}).encode(),
                headers={'Content-Type':'application/json'}, method='POST')
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())

        try:
            status, second = post('Revision')
            self.assertEqual(status, 200)
            self.assertEqual(second['path'], 'Course/Revision 2.canvas')
            self.assertEqual((course / 'Revision.canvas').read_bytes(), original)
            status, canvas = post('Only a note')
            self.assertEqual(status, 200)
            self.assertEqual(canvas['path'], 'Course/Only a note.canvas')
            self.assertEqual((course / 'Only a note.md').read_text(encoding='utf-8'), 'Keep my note')
        finally:
            httpd.shutdown()
            httpd.server_close()
            worker.join(3)


if __name__ == '__main__':
    unittest.main()
