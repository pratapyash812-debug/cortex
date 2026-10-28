"""Verify and atomically replace an app release, retaining an installation backup.

Requires Cortex to be closed. Never reads or changes a notebook folder. No process
is terminated and the signed Python executables must match the current runtime.
"""
from __future__ import annotations
import argparse,hashlib,json,os,shutil,subprocess,uuid
from datetime import datetime
from pathlib import Path

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def verify(source):
    manifest=json.loads((source/'release.json').read_text(encoding='utf-8'))
    for rel,digest in manifest['files'].items():
        path=(source/rel).resolve()
        if not path.is_relative_to(source.resolve()) or not path.is_file() or sha(path)!=digest:raise ValueError(f'Release verification failed: {rel}')
    return manifest
def deploy(source:Path,destination:Path):
    source=source.resolve();destination=destination.resolve();manifest=verify(source)
    if destination.name!='Cortex' or destination.parent.name!='Programs':raise ValueError('Expected the user-scope Cortex installation directory')
    if source==destination or source.is_relative_to(destination):raise ValueError('Release must be staged outside the active installation')
    for name in ('python.exe','pythonw.exe','python314.dll'):
        old=destination/'python'/name
        if old.exists() and sha(old)!=sha(source/'python'/name):raise ValueError(f'Signed runtime would change: {name}')
    # Refuse an active desktop/server process from this installation; never force close.
    if os.name=='nt':
        result=subprocess.run(['powershell','-NoProfile','-NonInteractive','-Command',"Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('python.exe','pythonw.exe') } | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"],check=True,capture_output=True,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
        processes=json.loads(result.stdout or '[]');processes=processes if isinstance(processes,list) else [processes]
        for process in processes:
            command=(process.get('CommandLine') or '').casefold()
            if str(destination/'app/server').replace('\\','/').casefold() in command.replace('\\','/'):
                raise RuntimeError('Close Cortex before installing; no running app was changed')
    staged=destination.parent/('Cortex-stage-'+uuid.uuid4().hex)
    shutil.copytree(source,staged);verify(staged)
    backup=destination/'backups'/('cortex-lean-'+datetime.now().strftime('%Y%m%d-%H%M%S'));backup.mkdir(parents=True,exist_ok=False)
    parts=('app','python')+tuple(p.name for p in source.iterdir() if p.is_file())
    moved=[];installed=[]
    try:
        for part in (*parts,'graphify'):
            old=destination/part
            if old.exists():old.rename(backup/part);moved.append(part)
        for part in parts:(staged/part).rename(destination/part);installed.append(part)
        verify(destination)
    except BaseException:
        for part in reversed(installed):(destination/part).rename(staged/part)
        for part in reversed(moved):(backup/part).rename(destination/part)
        raise
    # This staging folder is owned by this invocation and contains no notebook data.
    if staged.parent!=destination.parent or not staged.name.startswith('Cortex-stage-'):raise ValueError('Unexpected staging path')
    shutil.rmtree(staged)
    receipt={'version':manifest['version'],'backup':str(backup),'installedFiles':len(manifest['files']),'runtimeUnchanged':True}
    (backup/'deployment.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8');print(json.dumps(receipt,indent=2));return receipt
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,required=True);p.add_argument('--destination',type=Path,required=True);a=p.parse_args();deploy(a.source,a.destination)
