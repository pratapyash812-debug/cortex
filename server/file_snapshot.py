"""Stable local input identities shared by backups and PDF indexing."""
from __future__ import annotations
import hashlib,os
from pathlib import Path

class InputChanged(RuntimeError):pass
class WorkCancelled(RuntimeError):pass
_windows_identity_api=None

def _windows_change_time(path):
    """NTFS change stamp changes even if a writer restores LastWriteTime."""
    global _windows_identity_api
    try:
        import ctypes
        from ctypes import wintypes
        if _windows_identity_api is None:
            class BasicInfo(ctypes.Structure):
                _fields_=[(n,ctypes.c_longlong) for n in ('CreationTime','LastAccessTime','LastWriteTime','ChangeTime')]+[('FileAttributes',wintypes.DWORD)]
            library=ctypes.WinDLL('kernel32',use_last_error=True)
            create=library.CreateFileW;create.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE];create.restype=wintypes.HANDLE
            read=library.GetFileInformationByHandleEx;read.argtypes=[wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD];read.restype=wintypes.BOOL
            close=library.CloseHandle;close.argtypes=[wintypes.HANDLE];close.restype=wintypes.BOOL
            _windows_identity_api=(library,create,read,close,BasicInfo)
        _library,create,read,close,BasicInfo=_windows_identity_api
        handle=create(str(path),0x80,7,None,3,0,None)
        if handle==ctypes.c_void_p(-1).value:return None
        try:
            info=BasicInfo()
            return info.ChangeTime if read(handle,0,ctypes.byref(info),ctypes.sizeof(info)) else None
        finally:close(handle)
    except (OSError,ValueError,TypeError,AttributeError):return None

def identity(path:Path):
    s=path.stat()
    result=(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    return result+(_windows_change_time(path),) if os.name=='nt' else result

def cacheable(version):return os.name!='nt' or version[-1] is not None

def local_files(root:Path,include_metadata=True,suffix=None):
    root=root.resolve();found={}
    for p in sorted(root.rglob('*')):
        if suffix is not None and p.suffix.lower()!=suffix:continue
        if not p.is_file() or p.is_symlink() or not p.resolve().is_relative_to(root):continue
        rel=p.relative_to(root).as_posix();parts=Path(rel).parts
        if not include_metadata and any(part.startswith('.') for part in parts):continue
        if p.name=='writer.lock' or p.name.endswith(('.tmp','.sqlite3-wal','.sqlite3-shm')):continue
        if parts[:2] in (('.cortex','search'),('.cortex','document-index'),('.cortex','cache'),('.cortex','ai'),('.cortex','pdf-index')):continue
        if p.name.startswith('~$'):continue
        try:found[rel]=identity(p)
        except FileNotFoundError:raise InputChanged('A file changed during the scan')
    return found

def copy_stable(source:Path,destination:Path,expected,should_stop=lambda:False):
    if identity(source)!=expected:raise InputChanged(str(source))
    digest=hashlib.sha256();destination.parent.mkdir(parents=True,exist_ok=True)
    with source.open('rb') as src,destination.open('xb') as out:
        while True:
            if should_stop():raise WorkCancelled('Background work paused')
            data=src.read(1024**2)
            if not data:break
            digest.update(data);out.write(data)
    if identity(source)!=expected:raise InputChanged(str(source))
    return digest.hexdigest()

def file_hash(path:Path,should_stop=lambda:False):
    before=identity(path);h=hashlib.sha256()
    with path.open('rb') as stream:
        while True:
            if should_stop():raise WorkCancelled('Background work paused')
            chunk=stream.read(1024**2)
            if not chunk:break
            h.update(chunk)
    if identity(path)!=before:raise InputChanged(str(path))
    return h.hexdigest(),before

def vault_id(root:Path):return hashlib.sha256(os.path.normcase(str(root.resolve())).encode()).hexdigest()[:24]
