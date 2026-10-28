"""Stage a matched, hashed lean release from verified source and existing signed Python.

No network, package installs, model changes or writes to a user's vault.
The destination must not exist. Run web build/tests before this command.
"""
from __future__ import annotations
import argparse,hashlib,importlib.metadata as metadata,json,shutil,sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
MODULES=json.loads((ROOT/'packaging/runtime-modules.json').read_text())

TRUSTED_PYPDF_SITE=Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/Lib/site-packages'

def locked_packages(runtime_site,lock,pypdf_site=None):
    """Use the existing runtime; only pinned pure-Python pypdf may come from the bundled local runtime."""
    installed={d.metadata['Name'].lower().replace('_','-'):d for d in metadata.distributions(path=[str(runtime_site)])}
    selected=[]
    for name,version in lock.items():
        distribution=installed.get(name.lower().replace('_','-'));site=runtime_site
        if (distribution is None or distribution.version!=version) and name=='pypdf':
            site=Path(pypdf_site) if pypdf_site is not None else TRUSTED_PYPDF_SITE
            candidates={d.metadata['Name'].lower():d for d in metadata.distributions(path=[str(site)])}
            distribution=candidates.get('pypdf')
        if distribution is None or distribution.version!=version:raise ValueError(f'Existing local runtime must contain {name}=={version}; nothing was downloaded')
        if name=='pypdf':
            files=distribution.files
            if not files or any(Path(str(f)).suffix.lower() in ('.dll','.pyd','.so','.exe','.dylib') for f in files):raise ValueError('Only the pinned pure-Python pypdf package may be staged')
            for rel in files:
                source=Path(distribution.locate_file(rel)).resolve()
                if not source.is_relative_to(site.resolve()) or not source.is_file():raise ValueError('Invalid pypdf installed-file manifest')
        selected.append((distribution,site))
    return selected
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def stage(destination:Path,runtime:Path,pypdf_site:Path|None=None):
    destination=destination.resolve();runtime=runtime.resolve()
    if destination.exists():raise ValueError('Choose a new, empty release destination')
    if destination==ROOT or destination in ROOT.parents or runtime==destination or runtime in destination.parents:raise ValueError('Unsafe release destination')
    lock=json.loads((ROOT/'packaging/runtime-lock.json').read_text())
    site=runtime/'Lib/site-packages'
    packages=locked_packages(site,lock,pypdf_site)
    if not (ROOT/'web/dist/index.html').is_file():raise ValueError('Build the web app first')
    destination.mkdir(parents=True)
    for name in MODULES:
        target=destination/'app/server'/f'{name}.py';target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/'server'/f'{name}.py',target)
    shutil.copytree(ROOT/'web/dist',destination/'app/web/dist')
    shutil.copy2(ROOT/'packaging/cortex.ico',destination/'app/cortex.ico')
    shutil.copy2(ROOT/'README.md',destination/'app/README.md')
    (destination/'app/docs').mkdir()
    shutil.copy2(ROOT/'docs/lean-notes.md',destination/'app/docs/lean-notes.md')
    python=destination/'python';python.mkdir()
    for p in runtime.iterdir():
        if p.is_file():shutil.copy2(p,python/p.name)
    for distribution,package_site in packages:
        if distribution.files is None:raise ValueError(f'Missing installed file manifest: {distribution.metadata["Name"]}')
        for rel in distribution.files:
            source=Path(distribution.locate_file(rel)).resolve()
            if not source.is_relative_to(package_site.resolve()) or not source.is_file() or '__pycache__' in source.parts:continue
            target=python/'Lib/site-packages'/source.relative_to(package_site.resolve());target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
    # Entry paths refer only to this release, never the development environment.
    for pth in python.glob('python*._pth'):
        pth.write_text(f'{pth.stem}.zip\n.\nLib\\site-packages\nimport site\n',encoding='utf-8')
    for name in ('install.py','uninstall.py','Install Cortex.cmd','deploy_release.py'):
        shutil.copy2(ROOT/'packaging'/name,destination/name)
    files={p.relative_to(destination).as_posix():digest(p) for p in destination.rglob('*') if p.is_file()}
    manifest={'product':'Cortex','version':'1.2.3-library','python':sys.version.split()[0],'runtimePackages':lock,'files':files}
    (destination/'release.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    print(json.dumps({'destination':str(destination),'files':len(files),'bytes':sum(p.stat().st_size for p in destination.rglob('*') if p.is_file())},indent=2))
    return manifest
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--destination',type=Path,required=True);parser.add_argument('--runtime',type=Path,required=True);parser.add_argument('--pypdf-site',type=Path);args=parser.parse_args();stage(args.destination,args.runtime,args.pypdf_site)
