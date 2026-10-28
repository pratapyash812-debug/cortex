from pathlib import Path
import importlib.util,json,subprocess,sys,unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'app/server'))
import build_macos,smoke_test,pdf_index

class MacPackagingTests(unittest.TestCase):
    def test_payload_has_no_notebook_or_windows_runtime(self):
        build_macos.verify_inputs()
        files=json.loads((ROOT/'payload-manifest.json').read_text())
        self.assertTrue(any(p.startswith('app/web/dist/') for p in files))
        self.assertFalse(any(any(s in p.split('/') for s in ('.cortex','.venv','node_modules','Sources','_testvault')) for p in files))
        self.assertFalse(any(Path(p).suffix.lower() in ('.exe','.dll','.pyd','.docx','.pdf','.xlsx','.pptx','.zip') for p in files))

    def test_frozen_pdf_worker_dispatches_to_the_app_without_opening_a_gui(self):
        from tempfile import TemporaryDirectory
        import server
        with TemporaryDirectory() as directory:
            index=pdf_index.DocumentIndex(server.Vault(Path(directory)/'notes'),Path(directory)/'cache')
            try:
                with patch.object(sys,'frozen',True,create=True):
                    self.assertEqual(index._command(Path(directory)/'Course.pdf',3),[sys.executable,'--cortex-pdf-worker',str(Path(directory)/'Course.pdf'),'3'])
            finally:index.stop()

    def test_source_backend_smoke_uses_only_a_disposable_notebook(self):
        self.assertTrue(json.loads(smoke_test.backend_smoke())['ok'])

    def test_windows_cannot_silently_produce_a_fake_mac_disk_image(self):
        with patch.object(sys,'platform','win32'):
            with self.assertRaisesRegex(RuntimeError,'Apple Silicon Mac'):build_macos.build(ROOT/'should-not-exist')
        self.assertFalse((ROOT/'should-not-exist').exists())

if __name__=='__main__':unittest.main()
