from pathlib import Path
import json,os
from PyInstaller.utils.hooks import collect_data_files,copy_metadata

ROOT=Path(SPECPATH)
version=json.loads((ROOT/'version.json').read_text())['version']
web=ROOT/'web/dist' if (ROOT/'web/dist/index.html').exists() else ROOT/'app/web/dist'
datas=[(str(web),'web/dist'),(str(ROOT/'THIRD-PARTY-NOTICES'),'THIRD-PARTY-NOTICES')]
datas+=collect_data_files('webview')
for package in ('pypdf','keyring','cryptography','pywebview'):datas+=copy_metadata(package,recursive=True)
modules=[p.stem for p in (ROOT/'app/server').glob('*.py')]
a=Analysis([str(ROOT/'entry.py')],pathex=[str(ROOT),str(ROOT/'app/server')],binaries=[],datas=datas,
    hiddenimports=modules+['smoke_test','webview.platforms.cocoa','keyring.backends.macOS'],
    excludes=['PyQt5','PyQt6','PySide2','PySide6','gi','clr','pythonnet','tkinter','numpy','matplotlib'],noarchive=False)
pyz=PYZ(a.pure)
identity=os.environ.get('CORTEX_CODESIGN_IDENTITY') or None
exe=EXE(pyz,a.scripts,[],exclude_binaries=True,name='Cortex',console=False,debug=False,strip=False,upx=False,
    target_arch='arm64',codesign_identity=identity,entitlements_file=None)
collection=COLLECT(exe,a.binaries,a.datas,strip=False,upx=False,name='Cortex')
app=BUNDLE(collection,name='Cortex.app',icon=str(ROOT/'build-icon.icns'),bundle_identifier='app.cortex.notes',
    info_plist={'CFBundleName':'Cortex','CFBundleDisplayName':'Cortex','CFBundleShortVersionString':version,
      'CFBundleVersion':version,'LSMinimumSystemVersion':'13.0','NSHighResolutionCapable':True,
      'NSRequiresAquaSystemAppearance':False,'NSDocumentsFolderUsageDescription':'Cortex stores your notes and the original files you choose to import.',
      'NSAppTransportSecurity':{'NSAllowsLocalNetworking':True}})
