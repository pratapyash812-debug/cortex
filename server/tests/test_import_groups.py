"""Imported subject/section groups own only fresh notes, validated before IO."""
import sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server

class ImportGroupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.v=server.Vault(Path(self.temp.name));self.v.create('','Existing','Untouched')
        self.v.add_sheet('Existing.md','Old child')
    def tearDown(self):self.temp.cleanup()
    def payload(self):return {'Subject/Subject.md':'Overview','Subject/Book.md':'Book','Subject/Book/Chapter.md':'Chapter','__notebooks__':{'Subject/Subject.md':['Subject/Book.md'],'Subject/Book.md':['Subject/Book/Chapter.md']}}
    def test_nested_subject_and_long_document_groups_preserve_older_memberships(self):
        old=self.v._read_notebooks();result=self.v.write_imported(self.payload())
        self.assertEqual(result['written'],3);self.assertEqual(self.v._read_notebooks()['Existing.md'],old['Existing.md'])
        self.assertEqual([s['path'] for s in self.v.notebook('Subject/Book.md')['sheets']],['Subject/Book.md','Subject/Book/Chapter.md'])
        self.assertFalse((self.v.root/'__notebooks__').exists())
    def test_invalid_groups_never_create_files_or_replace_membership(self):
        scenarios=[
            {'Subject/Subject.md':['Existing.md']},
            {'Subject/Subject.md':['Subject/Subject.md']},
            {'Subject/Subject.md':['Subject/Book.md'],'Subject/Book.md':['Subject/Subject.md']},
            {'Subject/Subject.md':['Subject/Book/Chapter.md'],'Subject/Book.md':['Subject/Book/Chapter.md']},
            {'Subject/Subject.md':['Subject/Book.md','Subject/Book.md']},
            {'Subject/Subject.md':'Subject/Book.md'},
            {'Existing.md':['Subject/Book.md']},
            [],
        ]
        for groups in scenarios:
            with self.subTest(groups=groups):
                before={p.relative_to(self.v.root):p.read_bytes() for p in self.v.root.rglob('*') if p.is_file()}
                payload=self.payload();payload['__notebooks__']=groups
                with self.assertRaises(ValueError):self.v.write_imported(payload)
                after={p.relative_to(self.v.root):p.read_bytes() for p in self.v.root.rglob('*') if p.is_file()}
                self.assertEqual(before,after)
    def test_grouped_collision_is_not_silently_renamed(self):
        self.v.create('Subject','Book','Existing book')
        with self.assertRaisesRegex(ValueError,'fresh unique'):self.v.write_imported(self.payload())
        self.assertEqual(self.v.entry(self.v.resolve('Subject/Book.md')).body,'Existing book')
        self.assertFalse((self.v.root/'Subject/Subject.md').exists())
    def test_hidden_binary_and_case_alias_targets_are_rejected(self):
        for extra in ({'.cortex/Hidden.md':'bad','__notebooks__':{'.cortex/Hidden.md':['Subject/Book.md']}},{'Subject/book.md':'case alias'},{'__notebooks__':{'Subject/Subject.md':['Subject/source.md']},'Subject/source.md':b'binary original'}):
            with self.subTest(extra=list(extra)):
                payload=self.payload();payload.update(extra)
                with self.assertRaises(ValueError):self.v.write_imported(payload)
                self.assertFalse((self.v.root/'Subject').exists())

if __name__=='__main__':unittest.main()
