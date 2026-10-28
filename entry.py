"""Cortex Mac entry: worker modes dispatch before Cocoa or the GUI is imported."""
from pathlib import Path
import os,sys

ROOT=Path(__file__).resolve().parent
if not getattr(sys,'frozen',False):sys.path.insert(0,str(ROOT/'server'))
if sys.platform=='darwin':
    os.environ.setdefault('LOCALAPPDATA',str(Path.home()/'Library/Application Support'))

def main():
    if len(sys.argv)==4 and sys.argv[1]=='--cortex-pdf-worker':
        if sys.stdout is None:sys.stdout=os.fdopen(1,'w',encoding='utf-8',closefd=False)
        from pdf_index import _worker
        _worker(sys.argv[2],int(sys.argv[3]),'')
        return
    if sys.argv[1:]==['--cortex-self-test']:
        from smoke_test import backend_smoke
        print(backend_smoke(),flush=True)
        return
    if len(sys.argv)==3 and sys.argv[1]=='--cortex-gui-test':
        from smoke_test import gui_smoke
        gui_smoke(Path(sys.argv[2]))
        return
    for name in ('stdout','stderr'):
        if getattr(sys,name) is None:setattr(sys,name,open(os.devnull,'w'))
    import desktop
    desktop.main()

if __name__=='__main__':main()
