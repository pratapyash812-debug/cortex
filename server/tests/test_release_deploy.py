"""Installation replacement is recoverable and never overlays stale app files."""
import sys,json,tempfile,unittest,hashlib
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'packaging'))
import deploy_release

class ReleaseDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.source=self.root/'release';self.dest=self.root/'Programs/Cortex'
        for base in (self.source,self.dest):
            (base/'app/server').mkdir(parents=True);(base/'python').mkdir()
            for name in ('python.exe','pythonw.exe','python314.dll'):(base/'python'/name).write_bytes(b'unchanged signed-runtime fixture')
        (self.source/'app/server/server.py').write_text('new source')
        (self.dest/'app/server/server.py').write_text('old source')
        (self.dest/'app/stale-chunk.js').write_text('retired')
        self.original=self.root/'Notebook/Student.md';self.original.parent.mkdir();self.original.write_text('Student original')
        self.manifest()
    def tearDown(self):self.tmp.cleanup()
    def manifest(self):
        files={p.relative_to(self.source).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in self.source.rglob('*') if p.is_file() and p.name!='release.json'}
        (self.source/'release.json').write_text(json.dumps({'version':'test','files':files}))
    def test_complete_replacement_keeps_backup_and_drops_stale_assets(self):
        with patch.object(deploy_release.subprocess,'run') as command:
            command.return_value.stdout='[]';receipt=deploy_release.deploy(self.source,self.dest)
        self.assertEqual((self.dest/'app/server/server.py').read_text(),'new source');self.assertFalse((self.dest/'app/stale-chunk.js').exists())
        self.assertEqual((Path(receipt['backup'])/'app/server/server.py').read_text(),'old source')
        self.assertEqual(self.original.read_text(),'Student original')
    def test_failed_replacement_restores_original_install(self):
        rename=Path.rename
        def fail(path,target):
            if path.name=='app' and path.parent.name.startswith('Cortex-stage-'):raise OSError('Simulated app lock')
            return rename(path,target)
        with patch.object(deploy_release.subprocess,'run') as command,patch.object(Path,'rename',fail):
            command.return_value.stdout='[]'
            with self.assertRaisesRegex(OSError,'Simulated'):deploy_release.deploy(self.source,self.dest)
        self.assertEqual((self.dest/'app/server/server.py').read_text(),'old source');self.assertTrue((self.dest/'app/stale-chunk.js').exists())
    def test_changed_runtime_or_invalid_hash_refuses_before_replacement(self):
        (self.source/'python/python.exe').write_bytes(b'different runtime');self.manifest()
        with self.assertRaisesRegex(ValueError,'Signed runtime'):deploy_release.deploy(self.source,self.dest)
        self.assertEqual((self.dest/'app/server/server.py').read_text(),'old source')

if __name__=='__main__':unittest.main()
