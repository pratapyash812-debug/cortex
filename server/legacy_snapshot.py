"""Durable, read-only snapshots of retired features. Originals are never rewritten."""
from __future__ import annotations
import hashlib
import json
import re
from pathlib import Path
from datetime import datetime


def ensure(vault):
    """Capture old computed views once, before the first edit in a lean release."""
    marker=vault.root/'.cortex/legacy-migration.json'
    if marker.exists():return
    with vault._note_save_lock:
        if marker.exists():return
        # Detect old fences without building every parsed note/attachment cache.
        # Record even an empty migration, so normal launches do no repeated scan.
        legacy=any((vault.root/'.cortex'/name).exists() for name in ('bases.json','bookmarks.json','state.json','study.json')) or any('```cortex-' in p.read_text(encoding='utf-8',errors='replace') for p in vault.notes())
        result=read(vault) if legacy else {'snapshots':[],'notices':[]}
        vault._write_json_atomic(marker,{'version':1,'snapshots':len(result['snapshots']),'notices':result['notices']})


def read(vault) -> dict:
    from legacy_reader import LegacyReader
    reader = LegacyReader(vault)
    snapshots, notices = [], []
    def keep(name, text):
        encoded = text.encode('utf-8')
        digest = hashlib.sha256(encoded).hexdigest()
        destination = vault.root / '.cortex' / 'legacy' / (digest + '.json')
        if not destination.exists():
            vault._write_json_atomic(destination, {'name': name, 'text': text, 'sha256': digest})
        snapshots.append({'name': name, 'text': text})
    def render(name, fn):
        try:
            result = fn()
            if isinstance(result,dict) and (result.get('error') or result.get('ok') is False):
                raise ValueError(result.get('error') or result.get('errors'))
            keep(name,json.dumps(result,ensure_ascii=False,indent=2,default=str))
        except Exception as error:
            notices.append(f'{name}: snapshot could not be generated ({error}). Original data is retained.')
    for name in ('bases.json','bookmarks.json','state.json','study.json'):
        source=vault.root/'.cortex'/name
        if source.is_file():
            try:
                original=source.read_text(encoding='utf-8')
                keep('Original settings — '+name,original)
            except (OSError,UnicodeError) as error:
                notices.append(f'{name} remains on disk but could not be read: {error}')
    try:
        prefs=reader.base_prefs()
        for key in prefs:
            import schema
            try:
                folder,tag=schema.parse_scope_key(key)
                if schema.scope_key(folder,tag) != key: raise ValueError("unsupported saved scope")
            except ValueError as error:
                notices.append(f'Invalid legacy scope {key}: {error}');continue
            render('Database — '+key,lambda f=folder,t=tag:reader.base(f,t))
    except Exception as error:
        notices.append(f'Database settings could not be converted: {error}')
    for entry in vault.entries():
        for at,match in enumerate(re.finditer(r'^```cortex-(base|query|tasks)\s*\n(.*?)^```\s*$',entry.body,re.M|re.S)):
            kind,source=match.groups()
            render(f'{entry.rel} — {kind} block {at+1}',lambda k=kind,s=source:reader.block_data(k,s))
    # Previously saved snapshots stay readable after their source notes change.
    current={(s['name'],s['text']) for s in snapshots}
    directory=vault.root/'.cortex'/'legacy'
    if directory.exists():
        for path in sorted(directory.glob('*.json')):
            try:
                item=json.loads(path.read_text(encoding='utf-8'))
                key=(item['name'],item['text'])
                if key not in current:
                    snapshots.append({'name':'Earlier snapshot — '+key[0],'text':key[1]})
            except (OSError,ValueError,KeyError,TypeError):
                notices.append(f'Unreadable snapshot retained: {path.name}')
    return {'snapshots':snapshots,'notices':notices}
