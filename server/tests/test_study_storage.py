"""End-to-end storage checks over disposable libraries and original fixtures."""
from __future__ import annotations

import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import auto_backup
import docx_export
import folder_import
import publish
import server
from word_fixtures import pack


class StudyStorageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.vault = server.Vault(self.root / 'working-library')

    def test_preview_confirm_existing_subject_then_repeat_without_writes(self):
        notebook = self.vault.create_notebook('Business Economics')
        self.vault.add_sheet(notebook['path'], 'My own writing')
        importer = folder_import.StudyImports(self.vault)
        original = 'Term;Price\r\n"Æbler; store";15\r\n'.encode('cp1252')
        preview = importer.preview(original, 'Prices.csv', modified='2024-10-12T13:14:15Z')
        row = preview['files'][0]
        self.assertEqual(row['encoding'], 'cp1252')
        self.assertIn('Æbler; store', row['samples']['cp1252'])
        self.assertFalse((self.vault.root / 'Business Economics' / 'Prices').exists())
        result = importer.commit(preview['id'], 'Business Economics', {}, True)
        item = result['items'][0]
        self.assertEqual(item['status'], 'editable')
        self.assertEqual(self.vault.resolve(item['original']).read_bytes(), original)
        note = self.vault.info(self.vault.resolve(item['note']), True)
        self.assertIn('| Æbler; store | 15 |', note['content'])
        self.assertEqual(note['meta']['sourceModified'], '2024-10-12T13:14:15Z')
        self.assertIn('importedAt', note['meta'])
        self.assertEqual(self.vault._read_notebooks()[notebook['path']], [
            'Business Economics/My own writing.md', 'Business Economics/Prices/Prices.md',
        ])
        self.assertEqual(importer.reports()[0]['id'], result['id'])
        repeated = importer.preview(original, 'Prices.csv')
        self.assertEqual(repeated['files'][0]['duplicate'], item['note'])
        skipped = importer.commit(repeated['id'], 'Business Economics', {'Prices.csv':{'skip':True}}, True)
        self.assertEqual(skipped['written'], 0)
        self.assertEqual(skipped['items'][0]['status'], 'skipped')

    def test_stop_between_files_retains_all_originals_and_only_retries_unfinished(self):
        originals = {'Week 1/One.txt':b'One note', 'Week 1/Two.txt':b'Two note'}
        importer = folder_import.StudyImports(self.vault)
        preview = importer.preview(pack(originals), 'Economics.zip')
        converter = folder_import.convert_upload
        def cancel_after_first(*args, **kwargs):
            progress = kwargs['progress']
            def cancel(phase, processed, total, current):
                if phase == 'Converting' and processed == 1:
                    importer.cancel(preview['id'])
                return progress(phase, processed, total, current)
            return converter(*args, **{**kwargs, 'progress':cancel})
        with patch.object(folder_import, 'convert_upload', side_effect=cancel_after_first):
            result = importer.commit(preview['id'], 'Economics', {}, False)
        self.assertTrue(result['cancelled'])
        items = {item['status']:item for item in result['items']}
        self.assertEqual(set(items), {'editable','pending'})
        for item in items.values():
            self.assertEqual(self.vault.resolve(item['original']).read_bytes(), originals[item['name']])
        retry = importer.retry(result['id'])
        self.assertEqual([file['name'] for file in retry['files']], [items['pending']['name']])

    def test_undo_trash_restores_notebook_order_and_children(self):
        main = self.vault.create_notebook('Maths')['path']
        first = self.vault.add_sheet(main, 'First')['created']
        page = self.vault.add_sheet(main, 'Second')['created']
        tail = self.vault.add_sheet(main, 'Third')['created']
        with self.vault._nb_lock:
            child = self.vault.create('Maths/Second', 'Worked example', 'Solve 3x = 9')['path']
            self.vault._write_notebooks({main:[first,page,tail],page:[child]})
        deleted = self.vault.trash(page)
        self.assertEqual(self.vault._read_notebooks()[main], [first,tail])
        restored = self.vault.restore(deleted)
        self.assertEqual(restored['path'], page)
        self.assertEqual(self.vault._read_notebooks(), {main:[first,page,tail],page:[child]})

    def test_named_checkpoints_compare_any_two_without_reverting_current_page(self):
        note = self.vault.create('', 'Inflation', 'Real income increases.')
        first = self.vault.checkpoint(note['path'], 'Before class')
        revision = self.vault.save(note['path'], 'Real income falls.', None, note['revision'])
        second = self.vault.checkpoint(note['path'], 'Class correction')
        self.vault.save(note['path'], 'Depends on the income measure.', None, revision['revision'])
        history = {item['id']:item.get('label') for item in self.vault.history(note['path'])}
        self.assertEqual(history[first['id']], 'Before class')
        self.assertEqual(history[second['id']], 'Class correction')
        diff = self.vault.diff(note['path'], first['id'], second['id'])
        self.assertIn('increases', repr(diff))
        self.assertIn('falls', repr(diff))
        self.assertNotIn('Depends on', repr(diff))
        self.assertIn('Depends on', self.vault.info(self.vault.resolve(note['path']),True)['content'])

    def test_restore_is_a_verified_separate_library_and_kept_backup_survives_rotation(self):
        note = self.vault.create('Maths', 'Page', 'Backup version')
        service = auto_backup.BackupService(self.vault, self.root / 'archives', retention=1)
        self.addCleanup(service.stop)
        original = (self.vault.root / note['path']).read_bytes()
        kept = service.run_once(manual=True)
        service.keep_archive(kept['archive'], True)
        revision = self.vault.save(note['path'], 'New working version', None, note['revision'])
        next_backup = service.run_once(manual=True)
        self.vault.save(note['path'], 'Newest working version', None, revision['revision'])
        service.run_once(manual=True)
        self.assertTrue(Path(kept['path']).is_file())
        self.assertFalse(Path(next_backup['path']).exists())
        self.assertEqual(service.review_restore(kept['archive'])['notes'],1)
        restored = Path(service.restore_archive(kept['archive'])['folder'])
        self.assertNotEqual(restored, self.vault.root)
        self.assertEqual((restored/note['path']).read_bytes(), original)
        self.assertIn(b'Newest working version',(self.vault.root/note['path']).read_bytes())
        Path(kept['path']).write_bytes(b'changed archive')
        with self.assertRaisesRegex(ValueError, 'integrity could not be verified'):
            service.review_restore(kept['archive'])

    def test_archive_rejects_paths_leaving_restored_folder(self):
        memory = io.BytesIO()
        with zipfile.ZipFile(memory,'w') as archive:
            archive.writestr('../not-mine.md', 'Never write this.')
        with zipfile.ZipFile(memory) as archive:
            with self.assertRaisesRegex(ValueError, 'cannot be restored safely'):
                auto_backup.restore_entries(archive)

    def test_source_repair_updates_only_live_references_and_finds_all_referring_pages(self):
        note = self.vault.create('', 'Notes', 'Read [[old.pdf|Book]]. Keep the example \x60[[old.pdf]]\x60.')
        reference = self.vault.create('', 'Other note', '[[Sources/Book.pdf|Workbook]]')
        path = self.vault.resolve('Sources/Book.pdf')
        path.parent.mkdir()
        path.write_bytes(b'%PDF original fixture')
        self.assertEqual(self.vault.source_report(note['path'])['missing'], [{'name':'old.pdf','count':1}])
        self.vault.repair_source(note['path'],'old.pdf','Sources/Book.pdf')
        reread = self.vault.info(self.vault.resolve(note['path']),True)
        self.assertIn('[[Sources/Book.pdf|Book]]',reread['content'])
        self.assertIn('\x60[[old.pdf]]\x60',reread['content'])
        self.assertFalse(self.vault.source_report(note['path'])['missing'])
        self.assertEqual({item['path'] for item in self.vault.source_referrers('Sources/Book.pdf')}, {note['path'],reference['path']})

    def test_about_lists_only_a_verified_deployed_release(self):
        active = self.root/'Programs'/'Cortex'
        location = active/'app/server/server.py'
        location.parent.mkdir(parents=True)
        (active/'release.json').write_text(json.dumps({'version':'now'}))
        previous = active/'backups'/'cortex-lean-earlier'
        previous.mkdir(parents=True)
        (previous/'deployment.json').write_text('{}')
        payload = b'earlier app'
        (previous/'app.py').write_bytes(payload)
        (previous/'release.json').write_text(json.dumps({
            'product':'Cortex','version':'previous','files':{'app.py':hashlib.sha256(payload).hexdigest()},
        }))
        self.assertEqual(server.installed_release_info(location)['previous']['version'],'previous')
        (previous/'app.py').write_bytes(b'corrupt')
        self.assertEqual(server.installed_release_info(location), {'version':'now','previous':None})

    def test_chapter_exports_relative_portable_links_and_keeps_rich_math_marks(self):
        note = self.vault.create('Maths','One','''H<sub>2</sub>O and x<sup>2</sup>
[[Science/Two|Next chapter]] · [[Sources/Example.pdf|Original]]

$$
x^2 + y^2 = 1
$$
''')
        next_note = self.vault.create('Science','Two','Second page')
        attachment = self.vault.resolve('Sources/Example.pdf')
        attachment.parent.mkdir()
        attachment.write_bytes(b'%PDF original fixture')
        self.vault.create('Science','Not in chapter','This should not appear')
        paths = [next_note['path'], note['path']]
        preview = publish.print_preview(self.vault, paths)
        self.assertLess(preview.index('<h1>Two</h1>'), preview.index('<h1>One</h1>'))
        self.assertIn('<sub>2</sub>',preview)
        self.assertIn('<sup>2</sup>',preview)
        self.assertNotIn('This should not appear',preview)
        output = io.BytesIO()
        publish.write_note_bundle(self.vault, paths, output)
        with zipfile.ZipFile(output) as bundle:
            self.assertEqual(set(bundle.namelist()), {note['path'], next_note['path'], 'Sources/Example.pdf'})
            page = bundle.read(note['path']).decode('utf-8')
            self.assertIn('[Next chapter](../Science/Two.md)', page)
            self.assertIn('[Original](../Sources/Example.pdf)', page)
            self.assertEqual(bundle.read('Sources/Example.pdf'), attachment.read_bytes())
        payload = docx_export.export_note(self.vault,note['path'])
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            docx = archive.read('word/document.xml')
            self.assertIn(b'w:val="subscript"',docx)
            self.assertIn(b'w:val="superscript"',docx)
            self.assertIn(b'OMath'.lower(),docx.lower())


if __name__ == '__main__':
    unittest.main()
