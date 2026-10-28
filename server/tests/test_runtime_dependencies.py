"""Only the pinned pure-Python PDF reader may use an alternative local site."""
import sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'packaging'))
import stage_release

class RuntimeDependencyTests(unittest.TestCase):
    def test_existing_bundled_pypdf_is_selected_without_other_packages(self):
        site=stage_release.TRUSTED_PYPDF_SITE
        if not site.is_dir():self.skipTest('Bundled local dependency runtime unavailable')
        with tempfile.TemporaryDirectory() as root:
            packages=stage_release.locked_packages(Path(root),{'pypdf':'6.10.0'},site)
            self.assertEqual(len(packages),1);self.assertEqual(packages[0][0].metadata['Name'],'pypdf')
            self.assertEqual(packages[0][1],site)
            self.assertFalse(any(str(p).endswith(('.dll','.pyd','.so')) for p in packages[0][0].files))
    def test_version_mismatch_and_unrelated_missing_packages_are_not_substituted(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):stage_release.locked_packages(Path(root),{'pypdf':'0.0.0'},stage_release.TRUSTED_PYPDF_SITE)
            with self.assertRaises(ValueError):stage_release.locked_packages(Path(root),{'numpy':'2.5.4'},stage_release.TRUSTED_PYPDF_SITE)

if __name__=='__main__':unittest.main()
