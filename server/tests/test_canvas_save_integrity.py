import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
import server

class CanvasSaveIntegrity(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.v=server.Vault(Path(self.tmp.name))
        self.path=self.v.create_canvas('','Class graph')['path']
    def tearDown(self): self.tmp.cleanup()
    def test_delayed_canvas_update_cannot_recreate_a_trashed_path(self):
        self.v.trash(self.path)
        with self.assertRaises(FileNotFoundError): self.v.write_canvas(self.path,{'nodes':[],'edges':[]},create=False)
        self.assertFalse(self.v.resolve(self.path).exists())
    def test_delayed_drawing_update_cannot_recreate_state_for_trashed_path(self):
        self.v.trash(self.path)
        with self.assertRaises(FileNotFoundError): self.v.save_canvas_drawing(self.path,[{'points':[0,0,1,1]}])
        self.assertFalse(self.v._drawing_file(self.path).exists())
    def test_corrupt_drawing_is_not_presented_as_empty(self):
        target=self.v._drawing_file(self.path);target.parent.mkdir(parents=True,exist_ok=True)
        original=b'{broken student drawing'
        target.write_bytes(original)
        with self.assertRaisesRegex(ValueError,'original file has been kept'): self.v.canvas_drawing(self.path)
        self.assertEqual(target.read_bytes(),original)
    def test_atomic_json_failure_preserves_previous_canvas(self):
        path=self.v.resolve(self.path);original=path.read_bytes()
        with patch.object(server.os,'replace',side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError): self.v.write_canvas(self.path,{'nodes':[{'id':'new'}],'edges':[]},create=False)
        self.assertEqual(path.read_bytes(),original)
        self.assertEqual(list(path.parent.glob('.*.tmp')),[])

if __name__=='__main__':unittest.main()
