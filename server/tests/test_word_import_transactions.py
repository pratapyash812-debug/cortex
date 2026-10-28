"""Whole Word imports reserve a fresh namespace, including all image references."""
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server

class WordImportTransactions(unittest.TestCase):
    def test_repeated_import_keeps_each_document_and_attachment_namespace(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = server.Vault(Path(directory))
            def convert(data, name, dest_folder):
                return {f'{dest_folder}/Course.md': f'![[{dest_folder}/attachments/image.png]]\n',
                        f'{dest_folder}/attachments/image.png': data, '__stats__': {'pages': 1},
                        '__warnings__': ['Check the original equation.']}
            with patch.object(server.docx_import, 'convert_upload', convert, create=True):
                first = vault.import_word(b'original picture', 'Course.docx')
                second = vault.import_word(b'new picture', 'Course.docx')
            self.assertEqual((first['folder'], second['folder']), ('Word import', 'Word import 2'))
            self.assertEqual(first['warnings'], ['Check the original equation.'])
            for result, picture in [(first,b'original picture'),(second,b'new picture')]:
                folder=result['folder']
                self.assertEqual((vault.root/folder/'attachments/image.png').read_bytes(),picture)
                self.assertIn(f'![[{folder}/attachments/image.png]]', (vault.root/folder/'Course.md').read_text())
            self.assertFalse((vault.root/'__warnings__').exists())

    def test_concurrent_imports_allocate_distinct_complete_folders(self):
        with tempfile.TemporaryDirectory() as directory:
            vault=server.Vault(Path(directory))
            results, errors=[],[]
            gate=threading.Barrier(2)
            def convert(data,name,dest_folder):
                return {f'{dest_folder}/Course.md':data.decode(), '__stats__':{'pages':1}}
            def run(value):
                try:
                    gate.wait(3)
                    results.append(vault.import_word(value.encode(),'Course.docx'))
                except Exception as cause: errors.append(cause)
            with patch.object(server.docx_import,'convert_upload',convert,create=True):
                threads=[threading.Thread(target=run,args=(value,)) for value in ['first','second']]
                for thread in threads: thread.start()
                for thread in threads: thread.join(5)
            self.assertEqual(errors,[])
            self.assertEqual({r['folder'] for r in results},{'Word import','Word import 2'})
            self.assertEqual({(vault.root/r['folder']/'Course.md').read_text().strip() for r in results},{'first','second'})

if __name__=='__main__': unittest.main()
